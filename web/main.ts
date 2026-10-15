import QRCode from "qrcode";

// ---- WS contract -------------------------------------------------------------------------
interface CartLine { menu_id: string; name: string; qty: number; unit_price_cents: number; line_total_cents: number; quote: string }
type ServerMsg =
  | { type: "transcript"; text: string; final: boolean }
  | { type: "cart"; items: CartLine[]; total_cents: number; currency: string }
  | { type: "notice"; text: string }
  | { type: "checkout"; url: string }
  | { type: "paid" }
  | { type: "error"; text: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const transcriptEl = $("transcript");
const cartEl = $<HTMLUListElement>("cart");
const cartEmpty = $("cart-empty");
const totalEl = $("total");
const noticesEl = $("notices");
const qrArea = $("qr-area");
const qrCanvas = $<HTMLCanvasElement>("qr");
const qrLink = $<HTMLAnchorElement>("qr-link");
const overlay = $("overlay");
const startBtn = $<HTMLButtonElement>("start");
const connDot = $("conn");
const micStatus = $("mic-status");

// Currency comes from the menu (Stripe Price currency), sent with every cart message.
let currency = "gbp";
const money = (c: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(c / 100);
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

// ---- WebSocket ---------------------------------------------------------------------------
let ws: WebSocket;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => connDot.classList.add("on");
  ws.onclose = () => { connDot.classList.remove("on"); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data) as ServerMsg);
}
const send = (msg: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

function handle(msg: ServerMsg) {
  switch (msg.type) {
    case "transcript": return showTranscript(msg.text, msg.final);
    case "cart": currency = msg.currency || currency; return renderCart(msg.items, msg.total_cents);
    case "notice": return addNotice(msg.text, "notice");
    case "error": return addNotice(msg.text, "error");
    case "checkout": return showCheckout(msg.url);
    case "paid": return showPaid();
  }
}

// ---- Transcript --------------------------------------------------------------------------
let interimEl: HTMLParagraphElement | null = null;
function showTranscript(text: string, final: boolean) {
  transcriptEl.querySelector(".placeholder")?.remove();
  if (!interimEl) {
    interimEl = document.createElement("p");
    transcriptEl.append(interimEl);
  }
  interimEl.textContent = text;
  interimEl.className = final ? "final" : "interim";
  if (final) interimEl = null;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ---- Cart (keyed by menu_id so we can animate add / change / remove) ----------------------
function renderCart(items: CartLine[], total: number) {
  const seen = new Set<string>();
  for (const it of items) {
    seen.add(it.menu_id);
    let li = cartEl.querySelector<HTMLLIElement>(`li[data-id="${it.menu_id}"]:not(.removing)`);
    const html = `
      <div class="line-main"><span class="qty">${it.qty} ×</span><span class="name">${esc(it.name)}</span><span class="price">${money(it.line_total_cents)}</span></div>
      <div class="quote">“${esc(it.quote)}”</div>`;
    if (!li) {
      li = document.createElement("li");
      li.dataset.id = it.menu_id;
      li.className = "line adding";
      li.innerHTML = html;
      cartEl.append(li);
      li.addEventListener("animationend", () => li!.classList.remove("adding"), { once: true });
    } else if (li.dataset.sig !== `${it.qty}|${it.quote}`) {
      li.innerHTML = html;
      li.classList.remove("changed");
      void li.offsetWidth; // restart animation
      li.classList.add("changed");
    }
    li.dataset.sig = `${it.qty}|${it.quote}`;
  }
  for (const li of cartEl.querySelectorAll<HTMLLIElement>("li:not(.removing)")) {
    if (seen.has(li.dataset.id!)) continue;
    li.classList.add("removing");
    li.addEventListener("animationend", () => li.remove(), { once: true });
  }
  cartEmpty.classList.toggle("hidden", items.length > 0);
  totalEl.textContent = money(total);
}

function addNotice(text: string, kind: "notice" | "error") {
  const div = document.createElement("div");
  div.className = `notice ${kind}`;
  div.textContent = text;
  noticesEl.prepend(div);
  while (noticesEl.children.length > 4) noticesEl.lastElementChild!.remove();
}

async function showCheckout(url: string) {
  qrArea.classList.remove("hidden");
  qrLink.href = url;
  qrLink.textContent = "Open checkout ↗";
  await QRCode.toCanvas(qrCanvas, url, { width: 260, margin: 1 });
}

// ---- Paid / reset ------------------------------------------------------------------------
let resetTimer: number | undefined;
function showPaid() {
  overlay.classList.remove("hidden");
  clearTimeout(resetTimer);
  resetTimer = window.setTimeout(doReset, 5000);
}

function doReset() {
  clearTimeout(resetTimer);
  overlay.classList.add("hidden");
  send({ type: "reset" });
  transcriptEl.innerHTML = `<p class="placeholder">Tap <b>Start</b> and tell us what you'd like.</p>`;
  interimEl = null;
  cartEl.innerHTML = "";
  noticesEl.innerHTML = "";
  qrArea.classList.add("hidden");
  renderCart([], 0);
}

// ---- Mic ---------------------------------------------------------------------------------
let recorder: MediaRecorder | null = null;
async function toggleMic() {
  if (recorder) {
    recorder.stop();
    recorder.stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    startBtn.textContent = "🎙 Start";
    startBtn.classList.remove("live");
    micStatus.textContent = "Mic off";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = async (e) => {
      if (e.data.size && ws.readyState === WebSocket.OPEN) ws.send(await e.data.arrayBuffer());
    };
    recorder.start(250);
    startBtn.textContent = "■ Stop";
    startBtn.classList.add("live");
    micStatus.textContent = "Listening…";
  } catch (e) {
    addNotice(`Microphone unavailable: ${(e as Error).message}`, "error");
  }
}

// ---- Wire up -----------------------------------------------------------------------------
startBtn.onclick = toggleMic;
$("done").onclick = () => send({ type: "done" });
$("reset").onclick = doReset;
overlay.onclick = doReset;
$<HTMLFormElement>("text-form").onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("text-input");
  if (input.value.trim()) send({ type: "text", text: input.value });
  input.value = "";
};
connect();

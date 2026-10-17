// Search island: the only script on a Tidequill public site, loaded only on /search/.
// Reads the static index (search.json) and filters it in the browser.
const box = document.getElementById("results");
const input = document.getElementById("q");
const base = (box && box.dataset.index) || "/search.json";
let docs = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const words = (q) => q.toLowerCase().split(/\W+/).filter((w) => w.length > 1);

function score(d, terms) {
  let s = 0;
  const title = d.title.toLowerCase();
  const heads = d.headings.join(" ").toLowerCase();
  const rest = (d.description + " " + d.text).toLowerCase();
  for (const t of terms) {
    if (title.includes(t)) s += 5;
    if (heads.includes(t)) s += 2;
    if (rest.includes(t)) s += 1;
  }
  return s;
}

async function run(q) {
  const terms = words(q);
  if (!terms.length) {
    box.innerHTML = "";
    return;
  }
  if (!docs) docs = await fetch(base).then((r) => r.json()).catch(() => []);
  const prefix = base.replace(/\/search\.json$/, "");
  const hits = docs.map((d) => [score(d, terms), d]).filter((x) => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 30);
  box.innerHTML = hits.length
    ? `<p>${hits.length} result${hits.length === 1 ? "" : "s"}</p><ul class="results">${hits.map(([, d]) => `<li><a href="${esc(prefix + d.path)}">${esc(d.title)}</a><p>${esc(d.description || d.text)}</p></li>`).join("")}</ul>`
    : `<p>Nothing matches “${esc(q)}”. Try fewer or different words.</p>`;
}

if (box && input) {
  const q = new URLSearchParams(location.search).get("q") || "";
  input.value = q;
  run(q);
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => run(input.value), 120);
  });
  input.form?.addEventListener("submit", (e) => {
    e.preventDefault();
    history.replaceState(null, "", `?q=${encodeURIComponent(input.value)}`);
    run(input.value);
  });
}

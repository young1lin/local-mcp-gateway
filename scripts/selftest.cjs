const p = require("puppeteer-core");
(async () => {
  const b = await p.launch({ executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", headless: "new", args: ["--force-dark-mode", "--window-size=1600,1000"] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1600, height: 1000 });
  const errs = [];
  pg.on("pageerror", (e) => { const t = e.message.slice(0, 200); if (!errs.some((x) => x.includes(t.slice(0, 60)))) errs.push("PAGEERROR: " + t); });
  pg.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon") && !errs.some((x) => x.includes(m.text().slice(0, 60)))) errs.push("CONSOLE: " + m.text().slice(0, 200)); });
  const shot = (n) => pg.screenshot({ path: "D:\\\\dev\\\\local-mcp-gateway\\\\scripts\\\\shots\\\\" + n + ".png" });

  // ---- MCPs view ----
  await pg.goto("http://127.0.0.1:19999/", { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));
  await shot("01-mcps");
  // open a detail pane
  await pg.evaluate(() => { const r = document.querySelector(".side-row"); if (r) r.click(); });
  await new Promise((r) => setTimeout(r, 2000));
  await shot("02-mcp-detail");

  // ---- Tunnels view: groups, collapse, drag handles ----
  await pg.click('[data-view="tunnels"]');
  await new Promise((r) => setTimeout(r, 1800));
  await shot("03-tunnels");
  // toggle first group header
  const collapsed = await pg.evaluate(() => {
    const h = document.querySelector("[data-tg]");
    if (!h) return { found: false };
    const card = h.parentElement;
    const before = card.classList.contains("collapsed");
    h.click();
    return { found: true, before: before, after: card.classList.contains("collapsed") };
  });
  await new Promise((r) => setTimeout(r, 600));
  console.log("tunnel group toggle:", JSON.stringify(collapsed));
  await shot("04-tunnels-toggled");
  await pg.evaluate(() => { const h = document.querySelector("[data-tg]"); if (h) h.click(); });
  await new Promise((r) => setTimeout(r, 400));

  // ---- Traffic view ----
  await pg.click('[data-view="traffic"]');
  await new Promise((r) => setTimeout(r, 1500));
  await shot("05-traffic");

  // ---- Data view: the gauntlet ----
  await pg.click('[data-view="data"]');
  await new Promise((r) => setTimeout(r, 2000));
  await shot("06-data-empty");
  const tableOpened = await pg.evaluate(() => {
    const t = document.querySelector(".db-table");
    if (!t) return null;
    t.click();
    return t.querySelector(".db-table-name") ? t.querySelector(".db-table-name").textContent : t.textContent.slice(0, 30);
  });
  console.log("table opened:", tableOpened);
  await new Promise((r) => setTimeout(r, 3000));
  await shot("07-data-grid");

  // grid actually has rows?
  const gridInfo = await pg.evaluate(() => {
    const wrap = document.getElementById("dbGridWrap");
    return { cells: wrap ? wrap.querySelectorAll("td").length : 0, html: wrap ? wrap.innerHTML.length : 0 };
  });
  console.log("grid:", JSON.stringify(gridInfo));

  // every tab
  for (const label of ["Columns", "Indexes", "Foreign Keys", "DDL"]) {
    await pg.evaluate((l) => {
      const btn = Array.from(document.querySelectorAll(".db-tabs button")).find((x) => x.textContent.trim() === l);
      if (btn) btn.click();
    }, label);
    await new Promise((r) => setTimeout(r, 1200));
    await shot("08-data-" + label.toLowerCase());
    const has = await pg.evaluate((l) => {
      const btn = Array.from(document.querySelectorAll(".db-tabs button")).find((x) => x.textContent.trim() === l);
      return btn && btn.getAttribute("aria-selected") === "true";
    }, label);
    if (!has) console.log("TAB FAILED:", label);
  }
  // back to Data
  await pg.evaluate(() => {
    const btn = Array.from(document.querySelectorAll(".db-tabs button")).find((x) => x.textContent.trim() === "Data");
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // page-size custom dropdown: open, screenshot, pick last
  const ddOpened = await pg.evaluate(() => {
    const dd = document.querySelector(".db-data-ctl button.dd");
    if (!dd) return { found: false };
    dd.click();
    const m = document.querySelector(".dd-menu");
    return { found: true, menu: !!m, items: m ? m.querySelectorAll("button").length : 0 };
  });
  await new Promise((r) => setTimeout(r, 500));
  await shot("09-dd-open");
  console.log("pagesize dd:", JSON.stringify(ddOpened));
  await pg.evaluate(() => {
    const m = document.querySelector(".dd-menu");
    if (m) { const items = m.querySelectorAll("button"); items[items.length - 1].click(); }
  });
  await new Promise((r) => setTimeout(r, 2000));
  await shot("10-after-pagesize");
  const pageSize = await pg.evaluate(() => {
    const dd = document.querySelector(".db-data-ctl button.dd .dd-label");
    return dd ? dd.textContent : "?";
  });
  console.log("pagesize now:", pageSize);

  // SQL console open + run a query
  await pg.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "SQL");
    if (btn) btn.click();
  });
  await new Promise((r) => setTimeout(r, 800));
  const sqlTyped = await pg.evaluate(() => {
    const ta = document.getElementById("dbSql");
    if (!ta) return false;
    ta.value = "SELECT 1 AS one";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  await pg.evaluate(() => {
    const run = document.getElementById("dbSqlRun");
    if (run) run.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  await shot("11-sql-run");
  const sqlResult = await pg.evaluate(() => {
    const wrap = document.getElementById("dbGridWrap");
    return wrap ? wrap.textContent.includes("one") : false;
  });
  console.log("sql typed:", sqlTyped, "result shows col 'one':", sqlResult);

  // history dropdown got the query?
  const hist = await pg.evaluate(() => {
    const sel = document.getElementById("dbSqlHistory");
    const trig = sel && sel.nextElementSibling;
    return trig ? trig.querySelector(".dd-label").textContent.slice(0, 30) : "(no trig)";
  });
  console.log("history label:", hist);

  // connection dropdown: open, screenshot, switch away and back
  const connDd = await pg.evaluate(() => {
    const sel = document.getElementById("dbConn");
    const trig = sel.nextElementSibling;
    trig.click();
    const m = document.querySelector(".dd-menu");
    const n = m ? m.querySelectorAll("button").length : 0;
    return { menu: !!m, items: n };
  });
  await new Promise((r) => setTimeout(r, 400));
  await shot("12-conn-dd");
  console.log("conn dd:", JSON.stringify(connDd));
  await pg.evaluate(() => {
    const m = document.querySelector(".dd-menu");
    if (m) m.querySelectorAll("button")[0].click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // CSV + Import buttons exist and open something?
  const csvBtn = await pg.evaluate(() => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "CSV");
    if (!b) return { found: false };
    b.click();
    return { found: true };
  });
  await new Promise((r) => setTimeout(r, 1000));
  await shot("13-csv");
  console.log("csv:", JSON.stringify(csvBtn));
  await pg.keyboard.press("Escape");

  console.log("");
  console.log("=== ERRORS (" + errs.length + ") ===");
  errs.forEach((e) => console.log("  " + e));
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

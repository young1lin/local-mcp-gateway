import { el } from "./util.js";

/* ---------------------------------------------------------------------------------------------
   The panel-wide custom dropdown.

   A native <select>'s CLOSED box can be styled, but its option POPUP cannot — on Windows it is
   the system list, white in both themes, and it is the one control in the panel that never
   matched. So every select's UI is replaced here: the native element stays in the DOM, hidden,
   as the source of truth (value, options, change events all keep their meaning — call sites
   never change), and a trigger button plus a floating menu render its face.

   Attached automatically: a MutationObserver styles every <select> the moment it enters the
   DOM (the sheets and the Data view build theirs dynamically), so a view never opts in or out.
   ---------------------------------------------------------------------------------------------- */

// Prototype accessors, resolved lazily: importing this module under a DOM-stubbed Node (the
// panel boot test) must not throw on a browser global that only exists where a select does.
let valDesc = null, idxDesc = null, disDesc = null, htmlDesc = null;
function descs() {
  if (valDesc) return;
  const proto = HTMLSelectElement.prototype;
  valDesc = Object.getOwnPropertyDescriptor(proto, "value");
  idxDesc = Object.getOwnPropertyDescriptor(proto, "selectedIndex");
  disDesc = Object.getOwnPropertyDescriptor(proto, "disabled");
  htmlDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
}

let openState = null; // { menu, trig, sel, items, active }

function closeMenu() {
  if (!openState) return;
  openState.menu.remove();
  openState.trig.setAttribute("aria-expanded", "false");
  openState = null;
}

/** The trigger's label mirrors the selected option's text (not its value). */
function paint(sel, trig) {
  descs();
  const opt = sel.options && sel.options[sel.selectedIndex];
  trig.querySelector(".dd-label").textContent = opt ? opt.textContent : "";
  trig.disabled = disDesc.get.call(sel);
}

function openMenuFor(sel, trig) {
  closeMenu();
  const menu = el("div", "menu float dd-menu");
  menu.setAttribute("role", "listbox");
  menu.style.minWidth = trig.offsetWidth + "px";
  const items = [];
  let mark = null;
  Array.prototype.forEach.call(sel.options, function (o) {
    const b = el("button", "pick" + (o.selected ? " on" : ""));
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(o.selected));
    b.title = o.textContent;
    b.textContent = o.textContent;
    b.onclick = function () {
      descs();
      if (sel.value !== o.value) {
        valDesc.set.call(sel, o.value);
        paint(sel, trig);
        // Native change events do not fire on programmatic assignment; the panel's handlers are
        // onchange/addEventListener on the select, and a dispatched event reaches both.
        sel.dispatchEvent(new Event("change"));
      }
      closeMenu();
      trig.focus();
    };
    menu.appendChild(b);
    items.push(b);
    if (o.selected) mark = b;
  });
  if (!items.length) return; // nothing to choose — the trigger stays inert
  document.body.appendChild(menu);

  // Below the trigger, unless that runs off the window — then above it. Same policy as popupMenu.
  const r = trig.getBoundingClientRect();
  const mh = Math.min(menu.offsetHeight, 280);
  menu.style.maxHeight = "280px";
  const left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8));
  menu.style.left = left + "px";
  const below = r.bottom + 4;
  menu.style.top = (below + mh > window.innerHeight - 8 ? Math.max(8, r.top - mh - 4) : below) + "px";

  openState = { menu: menu, trig: trig, sel: sel, items: items };
  trig.setAttribute("aria-expanded", "true");
  (mark || items[0]).focus();
}

function buildTrigger(sel, ownClasses) {
  // Carry the select's own classes over: the per-view sizing rules (.db-pagesize, …) then shape
  // the trigger exactly as they shaped the select it stands in for.
  const trig = el("button", "dd" + (ownClasses ? " " + ownClasses : ""));
  trig.type = "button";
  if (sel.title) trig.title = sel.title;
  if (sel.getAttribute("aria-label")) trig.setAttribute("aria-label", sel.getAttribute("aria-label"));
  trig.setAttribute("aria-haspopup", "listbox");
  trig.setAttribute("aria-expanded", "false");
  trig.appendChild(el("span", "dd-label"));
  trig.appendChild(el("span", "dd-chev"));

  trig.onclick = function () {
    if (trig.disabled) return;
    if (openState && openState.trig === trig) closeMenu();
    else openMenuFor(sel, trig);
  };
  // The keyboard contract of a native select, on the trigger: open on Enter/Space/arrows.
  trig.onkeydown = function (e) {
    if (trig.disabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenuFor(sel, trig);
    }
  };
  return trig;
}

/** Take over one select. Idempotent; skips multi-selects, which have no dropdown face. */
function styleSelect(sel) {
  descs();
  if (!sel || !valDesc || sel.multiple || sel.dataset.ddDone) return; // no DOM select here — a stub
  sel.dataset.ddDone = "1";
  const ownClasses = sel.className; // captured BEFORE dd-native is stamped on, or the trigger inherits the hider
  sel.classList.add("dd-native"); // hidden; the trigger beside it is the face

  const trig = buildTrigger(sel, ownClasses);
  sel.insertAdjacentElement("afterend", trig);
  paint(sel, trig);

  // Programmatic writes must reach the face. The instance-level overrides shadow the prototype
  // accessors, so every existing "sel.value = x" / "sel.innerHTML = …" repaints the label.
  Object.defineProperty(sel, "value", {
    get: function () { return valDesc.get.call(sel); },
    set: function (v) { valDesc.set.call(sel, v); paint(sel, trig); },
    configurable: true,
  });
  Object.defineProperty(sel, "selectedIndex", {
    get: function () { return idxDesc.get.call(sel); },
    set: function (v) { idxDesc.set.call(sel, v); paint(sel, trig); },
    configurable: true,
  });
  Object.defineProperty(sel, "disabled", {
    get: function () { return disDesc.get.call(sel); },
    set: function (v) { disDesc.set.call(sel, v); paint(sel, trig); },
    configurable: true,
  });
  Object.defineProperty(sel, "innerHTML", {
    get: function () { return htmlDesc.get.call(sel); },
    set: function (v) { htmlDesc.set.call(sel, v); paint(sel, trig); },
    configurable: true,
  });
  const origAdd = sel.appendChild.bind(sel);
  sel.appendChild = function (node) { origAdd(node); paint(sel, trig); return node; };
}

/** Style everything already in the DOM, then watch for selects the views create later. Every
 *  global this wires is feature-detected: the module must import cleanly under the DOM-stubbed
 *  Node of the panel boot test, which has no MutationObserver and no body to observe. */
function initSelects() {
  Array.prototype.forEach.call(document.querySelectorAll("select"), styleSelect);
  if (typeof MutationObserver !== "undefined" && document.body) new MutationObserver(function (muts) {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "SELECT") styleSelect(n);
        else if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll("select"), styleSelect);
      }
    }
    // A re-render can remove an open trigger's subtree; its menu would be left floating.
    if (openState && !document.body.contains(openState.trig)) closeMenu();
  }).observe(document.body, { childList: true, subtree: true });

  // One open dropdown at a time, closed by any click outside it or by Escape/Tab.
  document.addEventListener("mousedown", function (e) {
    if (openState && !openState.menu.contains(e.target) && e.target !== openState.trig) closeMenu();
  });
  document.addEventListener("keydown", function (e) {
    if (!openState) return;
    if (e.key === "Escape" || e.key === "Tab") { closeMenu(); openState.trig.focus(); e.preventDefault(); return; }
    const items = openState.items;
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1 + items.length) % items.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  window.addEventListener("resize", closeMenu);
}

export { initSelects, styleSelect };

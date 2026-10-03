/*
 * The formatting buttons over the board's text boxes (every textarea marked
 * data-editor). This is the board's only script, and it's optional: without
 * it the boxes work the same and the BBCode is typed by hand. The CSP allows
 * scripts from /static only, so nothing here may be inline.
 */
(function () {
  "use strict";

  var BUTTONS = [
    { label: "B", title: "Bold (Ctrl+B)", open: "[b]", close: "[/b]", key: "b", cls: "ed-b" },
    { label: "I", title: "Italic (Ctrl+I)", open: "[i]", close: "[/i]", key: "i", cls: "ed-i" },
    { label: "U", title: "Underline (Ctrl+U)", open: "[u]", close: "[/u]", key: "u", cls: "ed-u" },
    { label: "S", title: "Strikethrough", open: "[s]", close: "[/s]", cls: "ed-s" },
    { label: "Quote", title: "Quote", open: "[quote]", close: "[/quote]", block: true },
    { label: "Code", title: "Code: shown as typed, in a fixed-width font", open: "[code]", close: "[/code]", block: true },
    { label: "• List", title: "Bulleted list: one item per line", list: "[list]" },
    { label: "1. List", title: "Numbered list: one item per line", list: "[list=1]" },
  ];

  /**
   * Replaces the selection with text, then selects from..to within it. Goes
   * through execCommand where it can, so Ctrl+Z undoes the button.
   */
  function insert(ta, text, from, to) {
    var start = ta.selectionStart;
    var end = ta.selectionEnd;
    ta.focus();
    var done = false;
    try {
      done = document.execCommand("insertText", false, text);
    } catch (e) {
      done = false;
    }
    if (!done || ta.value.slice(start, start + text.length) !== text) {
      ta.setRangeText(text, start, end, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
    ta.setSelectionRange(start + from, start + to);
  }

  /** Newlines that put a block tag on its own line, given the text around the selection. */
  function blockEdges(ta) {
    var before = ta.value.slice(0, ta.selectionStart);
    var after = ta.value.slice(ta.selectionEnd);
    return {
      pre: before === "" || before.slice(-1) === "\n" ? "" : "\n",
      post: after === "" || after.charAt(0) === "\n" ? "" : "\n",
    };
  }

  function wrap(ta, b) {
    var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    var open = b.open;
    var close = b.close;
    if (b.block) {
      var edges = blockEdges(ta);
      open = edges.pre + open + "\n";
      close = "\n" + close + edges.post;
    }
    insert(ta, open + sel + close, open.length, open.length + sel.length);
  }

  /** Each selected line becomes an item, less any "-", "*" or "1." it was typed with. */
  function list(ta, b) {
    var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    var lines = sel
      .split("\n")
      .map(function (l) {
        return l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
      })
      .filter(function (l) {
        return l !== "";
      });
    if (lines.length === 0) lines = [""];
    var edges = blockEdges(ta);
    var head = edges.pre + b.list + "\n";
    var items = lines
      .map(function (l) {
        return "[*] " + l;
      })
      .join("\n");
    insert(ta, head + items + "\n[/list]" + edges.post, head.length + items.length, head.length + items.length);
  }

  function apply(ta, b) {
    if (b.list) list(ta, b);
    else wrap(ta, b);
  }

  function attach(ta) {
    var bar = document.createElement("span");
    bar.className = "editor-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Formatting");
    BUTTONS.forEach(function (b) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "editor-button" + (b.cls ? " " + b.cls : "");
      button.textContent = b.label;
      button.title = b.title;
      // Keeps the focus, and so the selection, in the text box.
      button.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });
      button.addEventListener("click", function () {
        apply(ta, b);
      });
      bar.appendChild(button);
    });
    ta.parentNode.insertBefore(bar, ta);
    ta.addEventListener("keydown", function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      var key = e.key.toLowerCase();
      for (var i = 0; i < BUTTONS.length; i++) {
        if (BUTTONS[i].key === key) {
          e.preventDefault();
          apply(ta, BUTTONS[i]);
          return;
        }
      }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll("textarea[data-editor]"), attach);
})();

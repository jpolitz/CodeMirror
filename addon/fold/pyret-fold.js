(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  var Pos = CodeMirror.Pos;
  function cmp(a, b) { return a.line - b.line || a.ch - b.ch; }
  const DELIMS = ["fun", "when", "for", "if", "let",
                  "cases", "data", "shared", "check",
                  "try", "except", "letrec", "ask",
                  "lam", "method", "examples", "block",
                  "ref-graph"];
  const ENDDELIM = ["end"];
  const SPECIALDELIM = [{start: "(", end: ")"},
                        {start: "[", end: "]"},
                        {start: "{", end: "}"}];
  var ALLDELIMS = [].concat(DELIMS,ENDDELIM,"(",")","[","]","{","}");

  var delimrx = new RegExp("(" + DELIMS.join("|") + "|" +
                            ENDDELIM.join("|") + "|\\(|\\)|\\[|\\]|{|})", "g");

  function isOpening(text) {
    if (DELIMS.indexOf(text) != -1) {
      return true;
    }
    for (var i = 0; i < SPECIALDELIM.length; i++) {
      if (text === SPECIALDELIM[i].start) return true;
    }
    return false;
  }

  function isClosing(text) {
    if (ENDDELIM.indexOf(text) != -1) {
      return true;
    }
    for (var i = 0; i < SPECIALDELIM.length; i++) {
      if (text === SPECIALDELIM[i].end) return true;
    }
    return false;
  }

  function keyMatches(open, close) {
    if (DELIMS.indexOf(open) != -1) {
      return (ENDDELIM.indexOf(close) != -1);
    }
    for (var i = 0; i < SPECIALDELIM.length; i++) {
      if (open === SPECIALDELIM[i].start)
        return (close === SPECIALDELIM[i].end);
    }
    return false;
  }

  function indexOf(str, arr, startIdx) {
    startIdx = startIdx || 0;
    var idx = -1;
    arr.forEach(function(needle) {
      var temp = str.indexOf(needle, startIdx);
      if (temp != -1)
        idx = (idx === -1) ? temp : Math.min(temp, idx);
    });
    return idx;
  }

  function lastIndexOf(str, arr, fromIdx) {
    fromIdx = fromIdx || str.length;
    var idx = -1;
    arr.forEach(function(needle) {
      idx = Math.max(idx, str.lastIndexOf(needle, fromIdx));
    });
    return idx;
  }

  // Returns the index of the word in arr which
  // curIdx is inside of within str
  // dir => 1 = indexOf; -1 = lastIndexOf
  // (Basically indexOf and lastIndexOf plus
  //  accounting for starting in the middle of a word)
  function startIndex(str, arr, curIdx, dir) {
    dir = (dir === 1 || dir === -1) ? dir : 1;
    curIdx = (curIdx && curIdx >= 0) ? curIdx : 0;
    var idx = -1;
    if (dir === 1) {
      arr.forEach(function(needle) {
        var startIdx = curIdx - needle.length;
        startIdx = str.indexOf(needle, startIdx);
        if (startIdx != -1)
          idx = (idx === -1) ? startIdx : Math.min(idx, startIdx);
      });
    } else {
      arr.forEach(function(needle) {
        // startIdx == Worst case scenario
        var startIdx = curIdx;
        idx = Math.max(idx, str.lastIndexOf(needle, startIdx));
      });
    }
    return idx;
  }

  // Line startIndex, but returns the index of the
  // last character of the match
  function endIndex(str, arr, curIdx, dir) {
    var idx = startIndex(str, arr, curIdx, dir);
    if (idx === -1) return idx;
    str = str.substring(idx);
    var ret = -1;
    arr.forEach(function(needle) {
      if (needle === str.substring(0, needle.length))
        ret = idx + needle.length - 1;
    });
    return ret;
  }

  function Iter(cm, line, ch, range) {
    this.line = line; this.ch = ch;
    this.cm = cm; this.text = cm.getLine(line);
    this.min = range ? range.from : cm.firstLine();
    this.max = range ? range.to - 1 : cm.lastLine();
  }

  Iter.prototype.curPos = function() {
    return Pos(this.line, this.ch);
  };

  Iter.prototype.keywordAt = function(ch) {
    // getTokenTypeAt is (according to the CM docs)
    // faster, so quickly check that before falling
    // back onto the token string itself
    var tok = this.cm.getTokenTypeAt(Pos(this.line, ch));
    if (tok && /keyword/.test(tok)) {
      return true;
    }
    tok = this.cm.getTokenAt(Pos(this.line, ch));
    return tok && (ALLDELIMS.indexOf(tok.string) != -1);
  };

  Iter.prototype.nextLine = function() {
    if (this.line >= this.max) return;
    this.ch = 0;
    this.text = this.cm.getLine(++this.line);
    return true;
  };

  Iter.prototype.prevLine = function() {
    if (this.line <= this.min) return;
    this.text = this.cm.getLine(--this.line);
    this.ch = this.text.length;
    return true;
  };

  Iter.prototype.toKeywordEnd = function() {
    for (;;) {
      var idx = endIndex(this.text, ALLDELIMS, this.ch);
      if (idx == -1) { if (this.nextLine()) continue; else return; }
      if (!this.keywordAt(idx + 1)) { this.ch = idx + 1; continue; }
      this.ch = idx + 1;
      return true;
    }
  };

  Iter.prototype.toKeywordStart = function() {
    for (;;) {
      var idx = this.ch ? startIndex(this.text, ALLDELIMS, this.ch - 1, -1) : -1;
      if (idx == -1) { if (this.prevLine()) continue; else return; }
      if (!this.keywordAt(idx + 1)) { this.ch = idx; continue; }
      delimrx.lastIndex = idx;
      this.ch = idx;
      var match = delimrx.exec(this.text);
      if (match && match.index == idx) return match;
    }
  };

  Iter.prototype.toNextKeyword = function() {
    for (;;) {
      delimrx.lastIndex = this.ch;
      var found = delimrx.exec(this.text);
      if (!found) { if (this.nextLine()) continue; else return; }
      if (!this.keywordAt(found.index + 1)) { this.ch = found.index + 1; continue; }
      this.ch = found.index + found[0].length;
      return found;
    }
  };

  Iter.prototype.toPrevKeyword = function() {
    for (;;) {
      var kw = this.ch ? endIndex(this.text, ALLDELIMS, this.ch - 1, -1) : -1;
      if (kw == -1) { if (this.prevLine()) continue; else return; }
      if (!this.keywordAt(kw + 1)) { this.ch = kw; continue; }
      this.ch = kw + 1;
      return true;
    }
  };

  /**
   * Finds the closing keyword which matches the
   * token at the current position
   * FIXME: This and findMatchingOpen should have their loops
   * reordered in a cleaner fashion. (run keyMatches and then check length)
   */
  Iter.prototype.findMatchingClose = function(kw) {
    var stack = [];
    for (;;) {
      var next = this.toNextKeyword(), startLine = this.line;
      var startCh = this.ch - (next ? next[0].length : 0);
      if (!next || !(this.toKeywordEnd())) return;
      next = next[0];
      if (isClosing(next)) {
        if (stack.length === 0) {
          if (!kw || keyMatches(kw, next)) {
            return { keyword: next,
              from: Pos(startLine, startCh),
              to: Pos(this.line, this.ch) };
          } else return; // Mismatch
        } else {
          if (!keyMatches(stack.pop(), next)) return;
        }
      } else {
        stack.push(next);
      }
    }
  };

  /**
   * Finds the opening keyword which matches the
   * token at the current position
   * FIXME: @see Iter.prototype.findMatchingClose()
   */
  Iter.prototype.findMatchingOpen = function(kw) {
    var stack = [];
    for (;;) {
      var prev = this.toPrevKeyword();
      if (!prev) return;
      var endLine = this.line, endCh = this.ch;
      var start = this.toKeywordStart();
      if (!start) return;
      start = start[0];
      if (isClosing(start)) {
        stack.push(start);
      } else {
        if (stack.length === 0) {
          if (!kw || keyMatches(start, kw))
            return { keyword: start,
              from: Pos(this.line, this.ch),
              to: Pos(endLine, endCh) };
          return; // Mismatch
        }
        if (!keyMatches(start, stack.pop())) return;
      }
    }
  };

  CodeMirror.registerHelper("fold", "pyret", function(cm, start) {
    var iter = new Iter(cm, start.line, 0);
    for (;;) {
      var openKw = iter.toNextKeyword(), end;
      if (!openKw || iter.line != start.line || !(iter.toKeywordEnd())) return;
      openKw = openKw[0];
      if (!isClosing(openKw)) {
        var start = Pos(iter.line, iter.ch);
        var close = iter.findMatchingClose();
        return close && {from: start, to: close.from};
      }
    }
  });

  CodeMirror.findMatchingKeyword = function(cm, pos, range) {
    var iter = new Iter(cm, pos.line, pos.ch, range);
    if (indexOf(iter.text, ALLDELIMS) == -1) return;
    var end = iter.toKeywordEnd(), to = end && Pos(iter.line, iter.ch);
    var start = end && iter.toKeywordStart();
    if (!end || !start || cmp(iter, pos) > 0) return;
    var here = {from: Pos(iter.line, iter.ch), to: to, keyword: start[0]};
    if (isClosing(start[0])) {
      return {open: iter.findMatchingOpen(start[0]), close: here, at: "close"};
    } else {
      iter = new Iter(cm, to.line, to.ch, range);
      return {open: here, close: iter.findMatchingClose(start[0]), at: "open"};
    }
  };

  CodeMirror.findEnclosingKeyword = function(cm, pos, range) {
    var iter = new Iter(cm, pos.line, pos.ch, range);
    for (;;) {
      var open = iter.findMatchingOpen(null);
      if (!open) break;
      var forward = new Iter(cm, pos.line, pos.ch, range);
      var close = forward.findMatchingClose(open.keyword);
      if (close) return {open: open, close: close};
    }
  };
});

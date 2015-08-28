(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"), require("../fold/pyret-fold"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror", "../fold/pyret-fold"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  CodeMirror.defineOption("matchKeywords", false, function(cm, val, old) {
    if (old && old != CodeMirror.Init) {
      cm.off("cursorActivity", doMatchKeywords);
      cm.off("viewportChange", maybeUpdateMatch);
      clear(cm);
    }
    if (val) {
      cm.state.matchBothKeywords = typeof val == "object" && val.bothKeywords;
      cm.on("cursorActivity", doMatchKeywords);
      cm.on("viewportChange", maybeUpdateMatch);
      doMatchKeywords(cm);
    }
  });

  function clear(cm) {
    if (cm.state.keywordHit) cm.state.keywordHit.clear();
    if (cm.state.keywordOther) cm.state.keywordOther.clear();
    cm.state.keywordHit = cm.state.keywordOther = null;
  }

  function doMatchKeywords(cm) {
    cm.state.failedKeywordMatch = false;
    cm.operation(function() {
      clear(cm);
      if (cm.somethingSelected()) return;
      var cur = cm.getCursor(), range = cm.getViewport();
      range.from = Math.min(range.from, cur.line);
      range.to = Math.max(cur.line + 1, range.to);
      var match = CodeMirror.findMatchingKeyword(cm, cur, range);
      if (!match) return;
      if (cm.state.matchBothKeywords) {
        var hit = match.at == "open" ? match.open : match.close;
        if (hit) cm.state.keywordHit = cm.markText(hit.from, hit.to, {className: "CodeMirror-matchingbracket"});
      }
      var other = match.at == "close" ? match.open : match.close;
      if (other)
        cm.state.keywordOther = cm.markText(other.from, other.to, {className: "CodeMirror-matchingbracket"});
      else
        cm.state.failedKeywordMatch = true;
    });
  }

  function maybeUpdateMatch(cm) {
    if (cm.state.failedKeywordMatch) doMatchKeywords(cm);
  }

  CodeMirror.commands.toMatchingKeyword = function(cm) {
    var found = CodeMirror.findMatchingKeyword(cm, cm.getCursor());
    if (found) {
      var other = found.at == "close" ? found.open : found.close;
      if (other) cm.extendSelection(other.to, other.from);
    }
  };
});

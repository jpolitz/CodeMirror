// CodeMirror, copyright (c) by Marijn Haverbeke and others
// Distributed under an MIT license: http://codemirror.net/LICENSE

(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  var ie_lt8 = /MSIE \d/.test(navigator.userAgent) &&
    (document.documentMode == null || document.documentMode < 8);

  var Pos = CodeMirror.Pos;

  function findMatchingKeyword(cm, where, strict, config) {
    var doc = cm.getDoc();
    var line = cm.getLineHandle(where.line), pos = where.ch - 1;
    var match = (pos >= 0 && line.text.substring(pos)) || line.text.substring(++pos);
    var dir = match && ((match.charAt(0) === ';' && match.charAt(0)) || (match.length >= 3 && match.substring(0,3)));
    dir = dir && ((dir === 'end') || (dir === ';'));
    dir = dir ? -1 : 1;
    if (!match)
      return null;
    var idxPos = doc.indexFromPos(Pos(where.line, pos));
    var tok = cm.getTokenAt(Pos(where.line, pos + 1), true);
    var found = tok && tok.state && tok.state.matchTable.lookup(idxPos);
    console.log(idxPos);
    if (tok && tok.state.matchTable) {
      console.log(tok.state.matchTable);
    }
    found = found || (dir == 1 && scanForKeyword(cm, where, idxPos, dir, config));
    if (found == null)
      return null;
    return {start: Pos(where.line, pos), match: found, forward: dir > 0};
  }

  function scanForKeyword(cm, where, whereIdx, dir, config) {
    var maxScanLen = (config && config.maxScanLineLength) || 10000;
    var maxScanLines = (config && config.maxScanLines) || 1000;
    var stack = [];
    var lineEnd = dir > 0 ? Math.min(where.line + maxScanLines, cm.lastLine() + 1)
                          : Math.max(cm.firstLine() - 1, where.line - maxScanLines);
    for (var lineNo = where.line; lineNo != lineEnd; lineNo += dir) {
      var lineState = cm.getStateAfter(lineNo, true);
      if (!lineState) continue;
      lineState = lineState.matchTable;
      if (lineState.lookup(whereIdx)) {
        return lineState.lookup(whereIdx);
      }
    }
    return lineNo - dir == (dir > 0 ? cm.lastLine() : cm.firstLine()) ? false : null;
  }


  function matchKeywords(cm, autoclear, config) {
    
    var maxHighlightLen = cm.state.matchKeywords.maxHighlightLineLength || 1000;
    var marks = [], ranges = cm.listSelections();
    var doc = cm.getDoc();
    for (var i = 0; i < ranges.length; i++) {
      var match = ranges[i].empty() && findMatchingKeyword(cm, ranges[i].head, false, config);
      if (match && cm.getLine(doc.posFromIndex(match.match.start).line).length <= maxHighlightLen) {
        var style = match.match ? "CodeMirror-matchingbracket" : "CodeMirror-nonmatchingbracket";
        if (match.match) {
          var start = {start: doc.posFromIndex(match.match.start.start), end: doc.posFromIndex(match.match.start.end)};
          var end = {start: doc.posFromIndex(match.match.end.start), end: doc.posFromIndex(match.match.end.end)};
          marks.push(cm.markText(start.start, start.end, {className: style}));
          marks.push(cm.markText(end.start, end.end, {className: style}));
          marks.push(cm.markText(start.start, end.end, {className: style + "-region"}));
        } else if (cm.getTokenAt(match.start, true).wants instanceof Array) {
          marks.push(cm.markText(match.start, Pos(match.start.line, match.start.ch + 1), {className: style}));
        }
      }
    }
    

    if (marks.length) {
      // Kludge to work around the IE bug from issue #1193, where text
      // input stops going to the textare whever this fires.
      if (ie_lt8 && cm.state.focused) cm.display.input.focus();

      var clear = function() {
        cm.operation(function() {
          for (var i = 0; i < marks.length; i++) marks[i].clear();
        });
      };
      if (autoclear) setTimeout(clear, 800);
      else return clear;
    }
  }

  var currentlyHighlighted = null;
  function doMatchKeywords(cm) {
    cm.operation(function() {
      if (currentlyHighlighted) {currentlyHighlighted(); currentlyHighlighted = null;}
      currentlyHighlighted = matchKeywords(cm, false, cm.state.matchKeywords);
    });
  }

  CodeMirror.defineOption("matchKeywords", false, function(cm, val, old) {
    if (old && old != CodeMirror.Init)
      cm.off("cursorActivity", doMatchKeywords);
    if (val) {
      cm.state.matchKeywords = typeof val == "object" ? val : {};
      cm.on("cursorActivity", doMatchKeywords);
    }
  });

  CodeMirror.defineExtension("matchKeywords", function() {matchKeywords(this, true);});
  CodeMirror.defineExtension("findMatchingKeyword", function(pos, strict, config){
    return findMatchingKeyword(this, pos, strict, config);
  });
  CodeMirror.defineExtension("scanForKeyword", function(pos, dir, style, config){
    return scanForKeyword(this, pos, dir, style, config);
  });
});

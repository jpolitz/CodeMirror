(function(mod) {
  if (typeof exports == "object" && typeof module == "object") // CommonJS
    mod(require("../../lib/codemirror"));
  else if (typeof define == "function" && define.amd) // AMD
    define(["../../lib/codemirror"], mod);
  else // Plain browser env
    mod(CodeMirror);
})(function(CodeMirror) {
  "use strict";

  /*
   * Logic for Keyword/Bracket Matching
   */

  /* =========== WARNING ============
   * CodeMirror mangles 0 and 1-indexed
   * values to a certain extent. CodeMirror.Pos
   * (aliased as just "Pos") expects the
   * character index to be 1-indexed, while
   * token objects returned by methods such as
   * cm.getTokenAt have `start` and `end` character
   * indices which are 0-indexed. As such,
   * some things in this file might look
   * a little weird, but bear the above
   * in mind before tweaking.
   */

  var Pos = CodeMirror.Pos;

  /**
   * Returns the difference between two {@link CodeMirror.Pos} objects
   */
  function cmp(a, b) { return a.line - b.line || a.ch - b.ch; }

  /**
   * Like cmp(...), but accepts two positions representing
   * a range and returns the distance to the closest point
   * of [a, b]. (If a <= c <= b, returns 0).
   */
  function cmpClosest(a, b, c) {
    var ret = a.line - c.line
    if (ret) { return ret; }
    if (a.ch <= c.ch && c.ch <= b.ch) { return 0; }
    if (Math.abs(a.ch - c.ch) < Math.abs(b.ch - c.ch)) { return a.ch - c.ch; }
    return b.ch - c.ch;
  }

  var pyretMode = CodeMirror.getMode({},"pyret");
  if (pyretMode.name === "null") {
    throw Error("Pyret Mode not Defined");
  } else if (!pyretMode.delimiters || // Make sure delimiters exist
             !pyretMode.delimiters.opening ||      // and are valid
             !pyretMode.delimiters.closing) {
    throw Error("No correct delimiters defined in Pyret Mode");
  }
  // Opening Delimiter Tokens
  var DELIMS = pyretMode.delimiters.opening;
  // Closing Delimiter Tokents
  var ENDDELIM = pyretMode.delimiters.closing;
  // Tokens with closing tokens other than "end"
  var SPECIALDELIM = [{start: "(", end: ")"},
                      {start: "[", end: "]"},
                      {start: "{", end: "}"}];
  // Matches against any token text
  var delimrx = new RegExp("(" + DELIMS.join("|") + "|" +
                           ENDDELIM.join("|") + "|\\(|\\)|\\[|\\]|{|})", "g");

  // Encapsulates parent->sub-keyword relationship
  var SIMPLESUBKEYWORDS = {
    "if": ["else if", "else"], "fun": ["where"],
    "data": ["sharing", "where"], "method": ["where"]
  };

  // Represents subkeywords which cannot be followed
  // by any other keywords
  var LASTSUBKEYWORDS = {
    "if": "else"
  };

  // Like SIMPLESUBKEYWORDS, but goes from sub-keyword->parent
  var INV_SIMPLESUBKEYWORDS = {};
  Object.keys(SIMPLESUBKEYWORDS).forEach(function(key){
    var arr = SIMPLESUBKEYWORDS[key];
    arr.forEach(function(skw) {
      INV_SIMPLESUBKEYWORDS[skw] = INV_SIMPLESUBKEYWORDS[skw] || [];
      INV_SIMPLESUBKEYWORDS[skw].push(key);
    });
  });

  // Inverse mapping from LASTSUBKEYWORDS
  var INV_LASTSUBKEYWORDS = {};
  Object.keys(LASTSUBKEYWORDS).forEach(function(key){
    var kw = LASTSUBKEYWORDS[key];
    // Needs to be an array since mapping is (potentially) non-bijective
    INV_LASTSUBKEYWORDS[kw] = INV_LASTSUBKEYWORDS[kw] || [];
    INV_LASTSUBKEYWORDS[kw].push(key);
  });

  /**
   * Checks the given text for whether it is an opening keyword
   * (Done textually...assumption is that the text originates from
   * a keyword or builtin token type)
   * @param {string} text - The text to check
   * @returns {boolean} Whether the given text is an opening delimiter
   */
  function isOpening(text) {
    text = (typeof(text) === 'string') ? text : text.string;
    if (DELIMS.indexOf(text) != -1) {
      return true;
    }
    for (var i = 0; i < SPECIALDELIM.length; i++) {
      if (text === SPECIALDELIM[i].start) return true;
    }
    return false;
  }

  /**
   * Checks the given text for whether it is a closing keyword
   * (Done textually...assumption is that the text originates from
   * a keyword or builtin token type)
   * @param {string} text - The text to check
   * @returns {boolean} Whether the given text is a closing delimiter
   */
  function isClosing(text) {
    text = (typeof(text) === 'string') ? text : text.string;
    if (ENDDELIM.indexOf(text) != -1) {
      return true;
    }
    for (var i = 0; i < SPECIALDELIM.length; i++) {
      if (text === SPECIALDELIM[i].end) return true;
    }
    return false;
  }

  /**
   * Returns whether the given opening and closing tags
   * (textually) match. Undefined behavior if one or both
   * arguments are not valid
   * @param {string} open - The opening tag to check
   * @param {string} close - The closing tag to check
   * @returns {boolean} If the match succeeded
   */
  function keyMatches(open, close) {
    open = (typeof(open) === 'string') ? open : open.string;
    close = (typeof(close) === 'string') ? close : close.string;
    if (DELIMS.indexOf(open) != -1) {
      return (ENDDELIM.indexOf(close) != -1);
    }
    for (var i = 0; i < SPECIALDELIM.length; i++) {
      if (open === SPECIALDELIM[i].start)
        return (close === SPECIALDELIM[i].end);
    }
    return false;
  }

  /**
   * Returns true if the given token is a whitespace character
   * @param {Object} token
   * @returns {boolean} Whether the token is whitespace
   */
  function isWhitespace(token) {
    return (token.string.match(/^\s+$/));
  }

  /**
   * Functions like {@link String#indexOf}, except
   * accepts an array of needles to search for
   * (and returns the first match)
   * @param {string} str - The string to search
   * @param {string[]} arr - The list of needles to look for
   * @param {number} [startIdx=0] - The index to begin the search at
   * @returns {Object} The first index of a match, or -1 if there is none, and the matched word
   */
  function indexOf(str, arr, startIdx) {
    startIdx = startIdx || 0;
    var idx = -1;
    var word = null;
    arr.forEach(function(needle) {
      var temp = str.indexOf(needle, startIdx);
      if (temp != -1) {
        idx = (idx === -1) ? temp : Math.min(temp, idx);
        if (idx === temp)
          word = needle;
      }
    });
    return {index: idx, needle: word};
  }

  /**
   * Like {@link indexOf} and {@link lastIndexOf}, but
   * allows for the starting index to be inside of any matched words
   * @param {string} str - The string to search
   * @param {string[]} arr - The list of needles to look for
   * @param {number} [curIdx=0] - The index to begin the search at
   * @param {number} [dir=1] - The direction to search (1 == indexOf, -1 == lastIndexOf)
   * @returns {Object} The index of the matching word, if any. Otherwise, -1.
   */
  function startIndex(str, arr, curIdx, dir) {
    if (curIdx > str.length) return {index: -1, needle: null};
    dir = (dir === 1 || dir === -1) ? dir : 1;
    curIdx = (curIdx && curIdx >= 0) ? curIdx : 0;
    var idx = -1;
    var word = null;
    if (dir === 1) {
      arr.forEach(function(needle) {
        var startIdx = curIdx - needle.length;
        startIdx = str.indexOf(needle, startIdx);
        if (startIdx != -1) {
          idx = (idx === -1) ? startIdx : Math.min(idx, startIdx);
          // idx === startIdx iff we've replaced idx with startIdx
          if (idx === startIdx)
            word = needle;
        }
      });
    } else {
      arr.forEach(function(needle) {
        // startIdx == Worst case scenario
        var startIdx = str.lastIndexOf(needle, curIdx);
        idx = Math.max(idx, startIdx);
        if ((startIdx != -1) && (idx === startIdx))
          word = needle;
      });
    }
    return {index: idx, needle: word};
  }
  
  /**
   * Encapsulates an iterator over the CodeMirror instance's body
   * @param {CodeMirror} cm - The CodeMirror instance
   * @param {number} line - The active line
   * @param {number} ch - The active location on the line
   * @param {Object} [range] - The delimiting start/end lines for the iterator
   * @constructor
   */
  function TokenTape(cm, line, ch, range) {
    this.line = line;
    this.cm = cm;
    this.text = cm.getLine(line);
    this.min = range ? range.from : cm.firstLine();
    this.max = range ? range.to - 1 : cm.lastLine();
    var curTok = cm.getTokenAt(Pos(line, ch));
    this.current = {start: curTok.start, end: curTok.end};
  }

  /**
   * Duplicates this {@link TokenTape} object
   * @returns {TokenTape} the duplicated object
   */
  TokenTape.prototype.copy = function() {
    var ret = new TokenTape(this.cm,
                            this.line,
                            this.current.start + 1,
                            {from: this.min, to: this.max + 1});
    // Constructor messes with things, so we just need
    // a valid TokenTape and we can set the fields
    // ourselves, making sure to pass nothing by reference
    ret.line = this.line;
    ret.text = this.text;
    ret.min  = this.min;
    ret.max  = this.max;
    ret.current.start = this.current.start;
    ret.current.end   = this.current.end;
    return ret;
  };

  /**
   * Moves this {@link TokenTape} to the next line
   * @returns {boolean} Whether the move was successful
   */
  TokenTape.prototype.nextLine = function() {
    if (this.line >= this.max) {
      this.current.end = null;
      return false;
    }
    this.text = this.cm.getLine(++this.line);
    var fst = this.cm.getTokenAt(Pos(this.line, 1));
    // Empty line
    if ((fst.start === 0) && (fst.end === 0)) return this.nextLine();
    this.current.start = fst.start;
    this.current.end = fst.end;
    return true;
  };

  /**
   * Moves this {@link TokenTape} to the previous line
   * @returns {boolean} Whether the move was successful
   */
  TokenTape.prototype.prevLine = function() {
    if (this.line <= this.min) {
      this.current.start = null;
      return false;
    }
    this.text = this.cm.getLine(--this.line);
    if (this.text.length === 0) return this.prevLine();
    var last = this.cm.getTokenAt(Pos(this.line, this.text.length));
    // Empty line
    if ((last.start === 0) && (last.end === 0)) return this.prevLine();
    this.current.start = last.start;
    this.current.end = last.end;
    return true;
  };

  /**
   * Moves this {@link TokenTape} in the indicated direction
   * to the next non-whitespace token.
   * @returns {boolean} Whether the move was successful
   */
  TokenTape.prototype.move = function(dir) {
    if ((dir ===  1) && (this.current.end   === null)) return false;
    if ((dir === -1) && (this.current.start === null)) return false;
    if ((dir !==  1) && (dir !== -1)) {
      console.warn("Expected direction of 1 or -1. Given: " + dir.toString());
      return false;
    }
    function nextCh(ts) {
      if (dir === 1) return ts.current.end + 1;
      return ts.current.start;
    }
    function isEOL(ts) {
      if (dir === -1) return (ts.current.start === 0);
      return ts.current.end >= ts.text.length;
    }
    function moveLine(ts) {
      if (dir === 1) return ts.nextLine();
      return ts.prevLine();
    }
    function getTok(ts, useNext) {
      if (useNext) return ts.cm.getTokenAt(Pos(ts.line, nextCh(ts)));
      if (dir === 1) {
        return ts.cm.getTokenAt(Pos(ts.line, ts.current.end));
      }
      return ts.cm.getTokenAt(Pos(ts.line, ts.current.start + 1));
    }
    var curTok = getTok(this);
    if (!curTok) return false;
    this.current.start = curTok.start;
    this.current.end = curTok.end;
    for (;;) {
      // If at end/start of line, move to next/previous line
      if (isEOL(this)) {
        if (!moveLine(this)) return false;
        curTok = getTok(this);
      } else {
        curTok = getTok(this, true);
      }
      this.current.start = curTok.start;
      this.current.end = curTok.end;
      // Break and return if non-whitespace
      if (!isWhitespace(curTok)) return true;
    }
  };

  /**
   * EFFECTS: Advances the {@link TokenTape}
   *  to the next token
   * @returns {boolean} Whether the move succeeded
   */
  TokenTape.prototype.next = function() {
    return this.move(1);
  };

  TokenTape.prototype.cur = function() {
    var tok;
    var using = this.current.end;
    using = (using === null) ? using - 1 : this.current.start + 1;
    tok = this.cm.getTokenAt(Pos(this.line, using));
    tok.line = this.line;
    return tok;
  };

  /**
   * Like {@link TokenTape#next}, but doesn't advance the stream
   * @returns {Object} The next token in the stream
   */
  TokenTape.prototype.peekNext = function() {
    if (this.current.end === null) return null;
    var tok = this.cm.getTokenAt(Pos(this.line, this.current.start + 1));
    tok.line = this.line;
    return tok;
  };

  /**
   * Advances the {@link TokenTape} to the previous token
   * @returns {boolean} Whether the move succeeded
   */
  TokenTape.prototype.prev = function() {
    return this.move(-1);
  };

  /**
   * Like {@link TokenTape#prev}, but doesn't move back the stream
   * @returns {Object} The previous token in the stream
   */
  TokenTape.prototype.peekPrev = function() {
    if (this.current.start === null) return null;
    var curLine = this.line;
    var curCurrent = this.current;
    var tok;
    if (this.current.start === 0) {
      if (!this.prevLine()) {
        tok = null;
      } else {
        tok = this.cm.getTokenAt(Pos(this.line, this.current.start + 1));
        tok.line = this.line;
      }
    } else {
      tok = this.cm.getTokenAt(Pos(this.line, this.current.start));
      tok.line = this.line;
    }
    this.line = curLine;
    this.current = curCurrent;
    return tok;
  };

  /**
   * Finds the next token in the stream which matches the
   * given criteria
   * @param {Object} [opts] The search criteria ( uses opts.string and opts.type )
   * @returns {Object} The matching token, if any
   */
  TokenTape.prototype.findNext = function(opts) {
    opts = opts || {};
    var tokContents = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    function matches(tok) {
      return tok.string.match(tokContents) && tok.type && tok.type.match(type);
    }
    if (opts.cur) {
      var tok = this.cur();
      if (matches(tok)) return tok;
    }
    var next;
    while(next = this.next()) {
      var tok = this.cur();
      if (matches(tok)) return tok;
    }
    return null;
  };

  /**
   * Finds the previous token in the stream which matches the
   * given criteria
   * @param {Object} [opts] The search criteria ( uses opts.string and opts.type )
   * @returns {Object} The matching token, if any
   */
  TokenTape.prototype.findPrev = function(opts) {
    opts = opts || {};
    var tokContents = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var prev;
    while(prev = this.prev()) {
      var tok = this.cur();
      if (tok.string.match(tokContents) && tok.type && tok.type.match(type)) return tok;
    }
    return null;
  };

  /**
   * Like {@link TokenTape.prototype.findNext}, but looks at only the immediately 
   * next and current tokens (used in {@link CodeMirror.findMatchingKeyword} to
   * determine starting token)
   * NOTE: Favors tokens on the left of cursor
   * @param {Object} [opts] The search criteria ( uses opts.string and opts.type )
   * @returns {Object} The matching token, if any
   */
  TokenTape.prototype.findAdjacent = function(opts) {
    opts = opts || {};
    var startPos = opts.pos || Pos(this.line, this.current.start + 1);
    var matches = function(tok) {
      if (!tok) { return false; }
      var diff = cmpClosest(Pos(tok.line, tok.start), Pos(tok.line, tok.end), startPos);
      var sameLine = tok.line === startPos.line;
      var adjacent = sameLine && diff === 0;
      return adjacent;
    };
    opts.cur = true;
    var adj = this.findNext(opts);
    if (matches(adj)) {
      if (this.current.end === 0) {
        this.current.start = adj.start;
        this.current.end   = adj.end;
      }
      return adj;
    }
    return null;
  };

  function IterResult(token, fail, subs, badSubs) {
    this.token = token;
    this.fail = fail;
    this.subs = subs || [];
    this.badSubs = badSubs || [];
  }

  /**
   * Finds the keyword which matches the opening
   * or closing token at the current position (depending on
   * the direction being travelled)
   * @param {string} [kw] - The keyword to match
   * @param {int} [dir] - The direction to travel (-1 = Backward, 1 = Forward)
   * @returns {IterResult} The resulting matched opening keyword
   */
  TokenTape.prototype.findMatchingToken = function(kw, dir) {
    if (Math.abs(dir) !== 1)
      throw new Error("Invalid Direction Given to findMatchingToken: " + dir.toString());
    var forward = dir === 1;
    var stack = [];
    // kw => matched subkeywords
    var subs = {};
    // Array of keywords for which the
    // last subkeywords have already been found
    var lastFound = [];
    // kw => matched subkeywords that don't belong
    var badSubs = {};
    // Directionally-based behavior:
    var nextMatching = (forward ? this.findNext : this.findPrev).bind(this);
    var isDeeper = forward ? isOpening : isClosing;
    var isShallower = forward ? isClosing : isOpening;
    var stackEmpty = function(){ return stack.length === 0; };
    var toksMatch = function(tok){ return forward ? keyMatches(kw, tok) : keyMatches(tok, kw); };
    // Keeps `fun` from glowing red
    var failIfNoMatch = !forward;
    function dealWithAfterLast(tok, parent) {
      var toAdd = {from: Pos(tok.line, tok.start), to: Pos(tok.line, tok.end)}
      // If forward, the new subkeyword is just bad
      if (forward) {
        badSubs[parent] = badSubs[parent] || [];
        badSubs[parent].push(toAdd);
        return;
      }
      // We're going backward; if it's not a last subkeyword,
      // just add it; we're in good shape.
      var invLast = INV_LASTSUBKEYWORDS[tok.string] || [];
      if (invLast.indexOf(parent) === -1) {
        subs[parent] = subs[parent] || [];
        subs[parent].push(toAdd);
        return;
      }
      // Last subkeyword token found. Move the tokens
      // for the parent from subs to badsubs since
      // we found a last child
      if (subs[parent]) {
        badSubs[parent] = badSubs[parent] || [];
        subs[parent].forEach(function(child){
          badSubs[parent].push(child);
        });
      }
      subs[parent] = [toAdd];
    }
    for (;;) {
      var next = nextMatching({type: /builtin|keyword/});
      // Reached beginning or end of file; no match
      if (!next) return new IterResult(null, failIfNoMatch, kw ? subs[kw] : []);
      // If next is a subkeyword, respond accordingly
      var inv = INV_SIMPLESUBKEYWORDS[next.string];
      if (inv && stackEmpty()) {
        var nextFrom = Pos(next.line, next.start);
        var nextTo = Pos(next.line, next.end);
        inv.forEach(function(key){
          if (lastFound.indexOf(key) !== -1) {
            dealWithAfterLast(next, key);
          } else {
            if (LASTSUBKEYWORDS[key] === next.string)
              lastFound.push(key);
            subs[key] = subs[key] || [];
            subs[key].push({from: nextFrom, to: nextTo});
          }
        });
      }
      // Need to remove stack layer?
      if (isShallower(next)) {
        // If stack is empty, we've matched
        if (stackEmpty()) {
          var tok = {keyword: next,
                     from: Pos(next.line, next.start),
                     to: Pos(next.line, next.end)};
          var fail = !(!kw || toksMatch(next));
          return new IterResult(tok, fail,
                                fail ? [] : (forward ? subs[kw] : subs[next.string]),
                                forward ? badSubs[kw] : badSubs[next.string]);
        } else { // Otherwise, remove the layer
          stack.pop();
        }
      } else if (isDeeper(next)) { // Need to add layer to stack?
        stack.push(next);
      }
    }
  };

  /**
   * Finds the opening keyword which matches the
   * token at the current position
   * @param {string} [kw] - The keyword to match
   * @returns {IterResult} The resulting matched opening keyword
   */
  TokenTape.prototype.findMatchingOpen = function(kw) {
    return this.findMatchingToken(kw, -1);
  };
  /**
   * Finds the opening keyword which matches the
   * token at the current position
   * @param {string} [kw] - The keyword to match
   * @returns {IterResult} The resulting matched opening keyword
   */
  TokenTape.prototype.findMatchingClose = function(kw) {
    return this.findMatchingToken(kw, 1);
  };

  /**
   * Returns the parent token which matches with the given subtoken
   * (e.g. goes from "else if" to its matching "if")
   * @returns {IterResult} The matching parent token, if any
   */
  TokenTape.prototype.findMatchingParent = function(kw) {
    var stack = [];
    var skip = 0;
    var parents = INV_SIMPLESUBKEYWORDS[kw];
    if (!parents) {
      throw new Error("Non-Subkeyword given to findMatchingParent");
    }
    for (;;) {
      var prev = this.findPrev({type: /builtin|keyword/});
      if (!prev) return new IterResult(null, true);
      if (skip > 0) { skip--; continue; }
      var prevIsLast = Object.keys(INV_LASTSUBKEYWORDS).indexOf(prev.string) !== -1;
      // Syntax Error
      if (stack.length === 0 && prevIsLast) {
        return new IterResult(null, true);
      }
      if (isClosing(prev)) {
        stack.push(prev);
      } else if (stack.length === 0 && parents.indexOf(prev.string) != -1) {
        if (stack.length === 0)
          return new IterResult(prev, false, []);
        if (isOpening(prev))
          stack.pop();
      } else if (isOpening(prev)) {
        stack.pop();
      }
    }
  };

  /**
   * Returns folding region information to CodeMirror
   */
  CodeMirror.registerHelper("fold", "pyret", function(cm, start) {
    var tstream = new TokenTape(cm, start.line, 0);
    function getOpenPos(tok) {
      if (tok.string === "fun") {
        var tmp = tstream.copy();
        if (tmp.next()) {
          var tmpkw = tmp.cur();
          if (tmpkw && tmpkw.type === "function-name") {
            var last = Pos(tmpkw.line, tmpkw.end);
            var newLast;
            while (tmp.next()) {
              tmpkw = tmp.cur();
              if (tmpkw.line !== last.line)
                break;
              newLast = Pos(tmpkw.line, tmpkw.end);
              if (tmpkw.string === ":" && tmpkw.type === "builtin")
                return newLast;
            }
            return last;
          }
        }
      }
      return Pos(tok.line, tok.end);
    }
    // If keyword is at the very beginning of the line,
    // findNext won't match it, so we manually do the first check.
    var openKw = tstream.cur();
    if (!openKw || !openKw.type || !openKw.type.match(/keyword|builtin/))
      openKw = tstream.findNext({type: /keyword|builtin/, string: delimrx});
    else // getOpenPos won't line up correctly otherwise
      tstream.next();
    for (;;) {
      if (isOpening(openKw)) {
        var startKw = getOpenPos(openKw);
        var close = tstream.findMatchingClose(openKw.string);
        return close && close.token && {from: startKw, to: close.token.from};
      }
      openKw = tstream.findNext({type: /keyword|builtin/, string: delimrx});
      if (!openKw || openKw.line !== start.line) return;
    }
  });

  /**
   * Returns keyword-matching information to matchkw.js
   */
  CodeMirror.findMatchingKeyword = function(cm, pos, range) {
    // No special words on the current line
    var tstream = new TokenTape(cm, pos.line, pos.ch, range);
    var start = tstream.findAdjacent({type: /keyword|builtin/,
                                      string: delimrx,
                                      pos: pos});
    // Putting these three keywords in the delimrx regular expression breaks
    // invariants elsewhere...they are subkeywords, so kept separate
    if (!start) {
      tstream = new TokenTape(cm, pos.line, pos.ch, range);
      start = tstream.findAdjacent({type: /keyword|builtin/,
                                    string: /else|where|sharing/,
                                    pos: pos});
    }
    if (!start || cmp(Pos(start.line, start.start), pos) > 0) return;
    var here = {from: Pos(start.line, start.start), to: Pos(start.line, start.end)};
    var other;
    if (isClosing(start.string)) {
      //tstream.prev(); // Push back one word to line up correctly
      other = tstream.findMatchingOpen(start.string);
      return {open: other.token,
              close: here,
              at: "close",
              matches: !other.fail,
              extra: other.subs,
              extraBad: other.badSubs};
    } else if (Object.keys(INV_SIMPLESUBKEYWORDS).indexOf(start.string) != -1) {
      // It's a subkeyword; find its parent
      var parent = tstream.findMatchingParent(start.string);
      if (parent.fail) {
        return {open: parent.token,
                close: here,
                at: "close",
                matches: false,
                extra: [],
                extraBad: parent.badSubs};
      }
      return CodeMirror.findMatchingKeyword(cm,
                                            Pos(parent.token.line, parent.token.start),
                                            range);
    } else {
      other = tstream.findMatchingClose(start.string);
      return {open: here,
              close: other.token,
              at: "open",
              matches: !other.fail,
              extra: other.subs,
              extraBad: other.badSubs};
    }
  };
});

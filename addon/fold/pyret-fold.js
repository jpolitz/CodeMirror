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

  /**
   * Returns true if the given {@link CodeMirror.Pos} is
   * somewhere in or adjacent to the given open-close region
   */
  function inRegion(pos, open, close) {
    return cmpClosest(open, close, pos) === 0;
  }

  var pyretMode = CodeMirror.getMode({},"pyret");
  if (pyretMode.name === "null") {
    throw Error("Pyret Mode not Defined");
  } else if (!pyretMode.delimiters || // Make sure delimiters exist
             !pyretMode.delimiters.opening ||      // and are valid
             !pyretMode.delimiters.closing ||
             !pyretMode.delimiters.prefix_info ||      // Also check function prefix
             !pyretMode.delimiters.prefix_info.prefixes || // information is defined
             !pyretMode.delimiters.prefix_info.parent_keywords ||
             !pyretMode.delimiters.prefix_info.parent_builtins) {
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
    "data": ["with", "sharing", "where"], "method": ["where"]
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
    // Needs to be an array since mapping is (potentially) non-injective
    INV_LASTSUBKEYWORDS[kw] = INV_LASTSUBKEYWORDS[kw] || [];
    INV_LASTSUBKEYWORDS[kw].push(key);
  });

  // NOPFX_PROC_PARENTS and PREFIXES are constants for
  // use in isPrefixlessParent(...) and isPrefix(...)
  // (see documentation for those for further details)
  var PFX_INFO = pyretMode.delimiters.prefix_info;
  var NOPFX_PROC_PARENTS = [];
  for (var i = 0; i < PFX_INFO.parent_keywords.length; i++) {
    NOPFX_PROC_PARENTS.push({string: PFX_INFO.parent_keywords[i], type: 'keyword'});
  }
  for (var i = 0; i < PFX_INFO.parent_builtins.length; i++) {
    NOPFX_PROC_PARENTS.push({string: PFX_INFO.parent_builtins[i], type: 'builtin'});
  }

  var PREFIXES = [];
  for (var i = 0; i < PFX_INFO.prefixes.length; i++) {
    PREFIXES.push({string: PFX_INFO.prefixes[i], type: 'keyword'});
  }

  /**
   * Checks the given text for whether it is an opening keyword
   * (Done textually...assumption is that the text originates from
   * a keyword or builtin token type)
   * @param {token} text - The text to check
   * @returns {boolean} Whether the given text is an opening delimiter
   */
  function isOpening(text) {
    text = text.string;
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
   * @param {token} text - The text to check
   * @returns {boolean} Whether the given text is a closing delimiter
   */
  function isClosing(text) {
    text = text.string;
    if (ENDDELIM.indexOf(text) != -1) {
      return true;
    }
    for (var i = 0; i < SPECIALDELIM.length; i++) {
      if (text === SPECIALDELIM[i].end) return true;
    }
    return false;
  }

  /**
   * Checks if the given token matches any of the
   * criteria in the given array
   * @param {token} toCheck - The token being checked
   * @param {Array<Object>} arr - The criteria to check against
   * @returns {boolean} Whether the given token matches any of the given criteria
   */
  function matchesAny(toCheck, arr) {
    var idx = 0;
    for (; idx < arr.length; idx++) {
      // What's currently being checked
      var criteria = arr[idx];
      // Continue if criteria has text different from toCheck
      if (criteria.string && !(criteria.string === toCheck.string))
        continue;
      // Continue if criteria has type different from toCheck
      if (criteria.type && !(criteria.type === toCheck.type))
        continue;
      // toCheck meets all requirements, so return true
      return true;
    }
    return false;
  }

  /**
   * Checks if the given token can have children functions
   * which do not have `fun` or `method` prefixes.
   * @param {token} toCheck - The token being checked
   * @returns {boolean} Whether toCheck can have prefix-less function children
   */
  function isPrefixlessParent(toCheck) {
    return matchesAny(toCheck, NOPFX_PROC_PARENTS);
  }

  /**
   * Checks if the given token is a function prefix
   * @param {token} toCheck - The token being checked
   * @returns {boolean} Whether toCheck is a function prefix
   */
  function isPrefix(toCheck) {
    return matchesAny(toCheck, PREFIXES);
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
   * Checks if the function-name token that this
   * {@link TokenTape} is currently on is preceded
   * by dot-separated names. If so, it expands the
   * current token to include them.
   */
  TokenTape.prototype.grabDotted = function() {
    var cur = this.cur();
    if (cur.type !== 'function-name') {
      // Warn, since this shouldn't happen
      console.warn("Called grabDotted while not on a function name");
      return;
    }
    // Cannot be preceded by anything if we're already at the beginning
    if (this.current.start === null) return;
    // Now do the actual checking
    var lastAdj = cur;
    function isAdjacent(tok) { return lastAdj.start === tok.end && lastAdj.line === tok.line; }
    var copy = this.copy();
    // Just a double check that we actually are not at the beginning
    if (!copy.prev()){ return; }
    var next = copy.cur();
    while (next
           && (next.type === 'variable'
               || (next.type === 'builtin' && next.string === '.'))
           && (isAdjacent(next))) {
      // next is part of the dotted name
      lastAdj = next;
      if (!copy.prev()) break;
      next = copy.cur();
    }
    // Invalid name
    if (lastAdj.type === 'builtin') return;
    this.current.start = lastAdj.start;
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
    using = (using !== null) ? using : this.current.start + 1;
    tok = this.cm.getTokenAt(Pos(this.line, using));
    tok.line = this.line;
    return tok;
  };

  /**
   * Like {@link TokenTape#next}, but doesn't advance the stream
   * @returns {Object} The next token in the stream
   */
  TokenTape.prototype.peekNext = function() {
    var copy = this.copy();
    var isNext = copy.next();
    return isNext ? copy.cur() : null;
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
    var copy = this.copy();
    var isPrev = copy.prev();
    return isPrev ? copy.cur() : null;
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

  var DefEnum = {NONE : false, PREFIXED : 'PREFIXED', UNPREFIXED : 'UNPREFIXED'};
  /**
   * Returns true if the TokenTape is currently on top
   * of a function definition's function-name (does not require `fun` or
   * `method` prefixes)
   * @returns {DefEnum} Whether the TokenTape is on top of a
   *   function definition (PREFIXED === `fun` or `method` in
   *   front of definition)
   */
  TokenTape.prototype.onDefinition = function() {
    var cur = this.cur();
    if (!cur || (cur.type !== 'function-name'))
      return false;
    const IGNORE_ADJ = [{string: ':', type: 'builtin'}];
    function nextAdjacent(tok) {
      var next = copy.peekNext();
      if (!next || matchesAny(next, IGNORE_ADJ)) return false;
      return (tok.end === next.start && tok.line === next.line);
    }
    var copy = this.copy();
    copy.grabDotted();
    var hasPrefix = isPrefix(copy.peekPrev());
    var next = copy.next();
    if (!next)
      return false;
    cur = copy.cur();
    if (!cur || (cur.type !== 'builtin') || (cur.string !== '(') || !copy.next())
      return false;
    var depth = 1;
    // Match parentheses
    while (depth > 0) {
      cur = copy.cur();
      if (!cur)
        return false;
      if (cur.type !== 'builtin') {
        copy.next();
        continue;
      }
      switch (cur.string) {
      case '(': depth++; break;
      case ')': depth--; break;
      default: break;
      }
      if (!copy.next())
        return false;
    }
    // After this loop, we should be at a colon, if there is one
    cur = copy.cur();
    if (!cur || cur.type !== 'builtin')
      return false;
    if (cur.string === '->') {// Type annotation
      copy.next();
      cur = copy.cur();
      if (!cur || cur.type !== 'variable')
        return false;
      // Handle Dot-Separated type names
      var wantPeriod = true;
      while (nextAdjacent(cur)) {
        copy.next();
        cur = copy.cur();
        if (!cur ||
            !(wantPeriod ? (cur.type === 'builtin' && cur.string === '.')
              : (cur.type === 'variable')))
          return false;
        wantPeriod = !wantPeriod;
      }
      copy.next();
      cur = copy.cur();
      if (!cur || cur.type !== 'builtin')
        return false;
    }
    if (cur.string !== ':')
      return false;
    return hasPrefix ? DefEnum.PREFIXED : DefEnum.UNPREFIXED;
  }

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
   * @param {token} [kw] - The keyword to match
   * @param {int} [dir] - The direction to travel (-1 = Backward, 1 = Forward)
   * @returns {IterResult} The resulting matched opening keyword
   */
  TokenTape.prototype.findMatchingToken = function(kw, dir) {
    if (Math.abs(dir) !== 1)
      throw new Error("Invalid Direction Given to findMatchingToken: " + dir.toString());
    var kwType = kw.type;
    kw = kw.string;
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
    // Prefix-less functions
    var pfxlessFuns = [];
    // Prefix-less function stack depth (1 if backwards, since `end` will add a layer)
    var pfxlessDepth = forward ? 0 : 1;
    // Utility checker function for pfxlessDepth stack depth
    // (Checks for depth 0 if forwards and for depths 1 and 0 backwards)
    var atPfxlessDepth = function(){ return stack.length === pfxlessDepth || stackEmpty(); };
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
    // Wraps `next` as the matched result and returns
    function wrapAndReturn(next) {
      var tok = {keyword: next,
                 from: Pos(next.line, next.start),
                 to: Pos(next.line, next.end)};
      var fail = !(!kw || toksMatch(next)
                   || (kwType === 'function-name' && keyMatches('fun',next))
                   || (next.type === 'function-name' && toksMatch('fun')));
      var outSubs = (fail ? [] : (forward ? subs[kw] : subs[next.string])) || [];
      var outBadSubs = (forward ? badSubs[kw] : badSubs[next.string]) || [];
      if (pfxlessFuns.length !== 0) {
        if (isPrefixlessParent(forward ? {string: kw, type: kwType} : next))
          // Commenting this out for now, since, after testing it, it looks weird.
          // Uncommenting will highlight method names under `data` and object
          // expressions, but type names and non-method keys (respectively) will
          // *not* be highlighted. The inconsistency looks weird, and the alternative
          // of highlighting those as well would, in my opinion, highlight too many
          // things.
          outSubs = outSubs; //.concat(pfxlessFuns);
        else
          outBadSubs = outBadSubs.concat(pfxlessFuns);
      }
      return new IterResult(tok, fail, outSubs, outBadSubs);
    }
    for (;;) {
      var next = nextMatching({type: /builtin|keyword|function-name/});
      // Reached beginning or end of file; no match
      if (!next) {
        var outSubs = (kw ? subs[kw] : []) || [];
        var outBadSubs = (kw ? badSubs[kw] : []) || [];
        if (forward) {
          if (isPrefixlessParent({string: kw, type: kwType}))
            // See comment above
            outSubs = outSubs; //.concat(pfxlessFuns);
          else
            outBadSubs = outBadSubs.concat(pfxlessFuns);
        }
        return new IterResult(null, failIfNoMatch, outSubs, outBadSubs);
      }
      // Store locations in case of subtoken
      var nextFrom = Pos(next.line, next.start);
      var nextTo = Pos(next.line, next.end);
      // Deal with prefix-less function names
      if (next.type === 'function-name') {
        // Check if on function definition
        var onDef = this.onDefinition();
        // Want to call atPfxlessDepth before playing with the stack
        var atDepth = atPfxlessDepth();
        // Ignore if function is prefixed
        if (onDef === DefEnum.NONE || onDef === DefEnum.PREFIXED)
          continue;
        // We know this function is an unprefixed definition
        if (forward) {
          stack.push(next);
        } else {
          if (stackEmpty())
            return wrapAndReturn(next);
          stack.pop();
        }
        // If at correct stack depth, add to potential children
        if (atDepth)
          pfxlessFuns.push({from: nextFrom, to: nextTo});
        continue;
      }
      // If next is a subkeyword, respond accordingly
      var inv = INV_SIMPLESUBKEYWORDS[next.string];
      if (inv && stackEmpty()) {
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
          return wrapAndReturn(next);
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
   * @param {token} [kw] - The keyword to match
   * @returns {IterResult} The resulting matched opening keyword
   */
  TokenTape.prototype.findMatchingOpen = function(kw) {
    return this.findMatchingToken(kw, -1);
  };
  /**
   * Finds the opening keyword which matches the
   * token at the current position
   * @param {token} [kw] - The keyword to match
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
    kw = kw.string;
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
      function getPostFunctionName(stream) {
        var cur = stream.cur();
        if (!cur) return null;
        var last = Pos(cur.line, cur.end);
        var newLast;
        while (stream.next()) {
          cur = stream.cur();
          if (cur.line !== last.line)
            break;
          newLast = Pos(cur.line, cur.end);
          if (cur.type === 'builtin' && cur.string === ':')
            return newLast;
        }
        return last;
      }
      var tmp = tstream.copy();
      var res;
      if (isPrefix(tok)) {
        if (tmp.next()) {
          var tmpkw = tmp.cur();
          if (tmpkw && tmpkw.type === 'function-name')
            if (res = getPostFunctionName(tmp))
              return res;
        }
      } else if (tok.type === 'function-name') {
        if (res = getPostFunctionName(tmp))
          return res;
      }
      return Pos(tok.line, tok.end);
    }
    function validKwBuiltin(tok) {
      return tok && tok.type.match(/keyword|builtin/) && tok.string.match(delimrx);
    }
    // If keyword is at the very beginning of the line,
    // findNext won't match it, so we manually do the first check.
    var openKw = tstream.cur();
    if (!tstream.onDefinition()
        && (!openKw || !openKw.type || !openKw.type.match(/keyword|builtin/))) {
      while (true) {
        openKw = tstream.findNext({type: /keyword|builtin|function-name/});
        if (!openKw || validKwBuiltin(openKw) || tstream.onDefinition())
          break;
      }
    }
    else // getOpenPos won't line up correctly otherwise
      tstream.next();
    for (;;) {
      var onDef = tstream.onDefinition();
      if ((onDef == DefEnum.UNPREFIXED) || isOpening(openKw)) {
        if (onDef) tstream.grabDotted();
        var startKw = getOpenPos(openKw);
        var close = tstream.findMatchingClose(openKw);
        return close && close.token && {from: startKw, to: close.token.from};
      }
      while (true) {
        openKw = tstream.findNext({type: /keyword|builtin|function-name/});
        if (!openKw || validKwBuiltin(openKw) || tstream.onDefinition())
          break;
      }
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
    // Check for unprefixed functions
    if (!start) {
      tstream = new TokenTape(cm, pos.line, pos.ch, range);
      start = tstream.findAdjacent({type: /function-name/, pos: pos});
      if (start) {
        var onDef = tstream.onDefinition();
        if (onDef === DefEnum.NONE) {
          start = null;
        } else if (onDef === DefEnum.PREFIXED) {
          tstream.grabDotted();
          tstream.prev();
          start = tstream.cur();
        }
      }
    }
    // Lastly, check if we're somewhere else in a dotted name
    if (!start) {
      tstream = new TokenTape(cm, pos.line, pos.ch, range);
      start = tstream.findAdjacent({type: /builtin|variable/, pos: pos});
      if (start && (start.type === 'builtin' ? start.string === '.' : true)) {
        var nextFun = tstream.findNext({type: /function-name/, pos: pos});
        if (!nextFun) start = null;
        else {
          tstream.grabDotted();
          var funstart = Pos(tstream.line,tstream.current.start);
          var funend = Pos(tstream.line,tstream.current.end);
          if (inRegion(pos,funstart,funend)) {
            tstream.prev();
            start = tstream.cur();
          } else {
            start = null;
          }
        }
      } else start = null;
    }
    if (!start || cmp(Pos(start.line, start.start), pos) > 0) return;
    var here = {from: Pos(start.line, start.start), to: Pos(start.line, start.end)};
    var other;
    if (isClosing(start)) {
      //tstream.prev(); // Push back one word to line up correctly
      other = tstream.findMatchingOpen(start);
      return {open: other.token,
              close: here,
              at: "close",
              matches: !other.fail,
              extra: other.subs,
              extraBad: other.badSubs};
    } else if (Object.keys(INV_SIMPLESUBKEYWORDS).indexOf(start.string) != -1) {
      // It's a subkeyword; find its parent
      var parent = tstream.findMatchingParent(start);
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
      other = tstream.findMatchingClose(start);
      return {open: here,
              close: other.token,
              at: "open",
              matches: !other.fail,
              extra: other.subs,
              extraBad: other.badSubs};
    }
  };
});

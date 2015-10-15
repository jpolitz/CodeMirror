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

  /**
   * Returns the difference between two {@link CodeMirror.Pos} objects
   */
  function cmp(a, b) { return a.line - b.line || a.ch - b.ch; }

  function cmpClosest(a, b, c) {
    var ret = a.line - c.line
    if (ret) { return ret; }
    if (a.ch <= c.ch && c.ch <= b.ch) { return 0; }
    if (Math.abs(a.ch - c.ch) < Math.abs(b.ch - c.ch)) { return a.ch - c.ch; }
    return b.ch - c.ch;
  }

  var DELIMS;
  var ENDDELIM;
  var SPECIALDELIM;
  var ALLDELIMS;
  var delimrx;


  /**
   * Kludge of the century...for some reason, defineInitHook doesn't
   * run this before findMatchingKeyword runs (which it needs to).
   * Thus, both defineInitHook and findMatchingKeyword are hooked
   * up to this function, which basically deletes itself after one run.
   */
  var initHandler = function(cm) {
    var pyretMode = cm.getDoc().getMode();
    if (!pyretMode.delimiters) {
      console.warn("Unable to find Pyret Delimiters");
      // To keep things from completely blowing up
      DELIMS = [];
      ENDDELIM = [];
    } else {
      DELIMS = pyretMode.delimiters.opening;
      ENDDELIM = pyretMode.delimiters.closing;
    }
    SPECIALDELIM = [{start: "(", end: ")"},
      {start: "[", end: "]"},
      {start: "{", end: "}"}];
    ALLDELIMS = [].concat(DELIMS,ENDDELIM,"(",")","[","]","{","}");

    delimrx = new RegExp("(" + DELIMS.join("|") + "|" +
      ENDDELIM.join("|") + "|\\(|\\)|\\[|\\]|{|})", "g");
    initHandler = function(){};
  };

  CodeMirror.defineInitHook(initHandler);

  var SIMPLESUBKEYWORDS = {
    "if": ["else if", "else"], "fun": ["where"],
    "data": ["sharing", "where"], "method": ["where"]
  };

  var SEQSUBKEYWORDS = {
    "if": [["else", "if"]]
  };

  var INV_SIMPLESUBKEYWORDS = {};
  Object.keys(SIMPLESUBKEYWORDS).forEach(function(key){
    var arr = SIMPLESUBKEYWORDS[key];
    arr.forEach(function(skw) {
      INV_SIMPLESUBKEYWORDS[skw] = INV_SIMPLESUBKEYWORDS[skw] || [];
      INV_SIMPLESUBKEYWORDS[skw].push(key);
    });
  });

  var FLAT_SEQ = [];
  Object.keys(SEQSUBKEYWORDS).forEach(function(k) {
    var tmp = [];
    SEQSUBKEYWORDS[k].forEach(function(arr){tmp = tmp.concat(arr);});
    FLAT_SEQ = FLAT_SEQ.concat(tmp);
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
   * FIXME: Non-carbon copies are only 'close-ish.' Other
   * code in this file depends on those incorrect copies.
   * once they are fixed, the `carbon` parameter can be
   * refactored out.
   * @returns {TokenTape} the duplicated object
   */
  TokenTape.prototype.copy = function(carbon) {
    if (carbon) {
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
    }
    return new TokenTape(this.cm,
      this.line,
      this.current.start,
      {from: this.min, to: this.max});
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
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    function matches(tok) {
      return tok.string.match(string) && tok.type && tok.type.match(type);
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
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var prev;
    while(prev = this.prev()) {
      var tok = this.cur();
      if (tok.string.match(string) && tok.type && tok.type.match(type)) return tok;
    }
    return null;
  };

  /**
   * Like findNext, but looks at only the immediately 
   * next and current tokens (used in findMatchingKeyword to
   * determine starting token)
   * NOTE: Favors tokens on the right of cursor
   */
  TokenTape.prototype.findAdjacent = function(opts) {
    opts = opts || {};
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var startPos = opts.pos || Pos(this.line, this.current.start + 1);
    var matches = function(tok) {
      if (!tok) { return false; }
      //var meetsCriteria =  tok.string.match(string) && tok.type && tok.type.match(type);
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

  /**
   *
   * @param {Object} [opts] Predicate criteria ( uses opts.string and opts.type )
   * @returns {boolean} Whether the next token in the stream meets
   * the criteria in opts
   */
  TokenTape.prototype.nextMatches = function(opts) {
    opts = opts || {};
    opts.filterOut = opts.filterOut || {};
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var filterString = opts.filterOut.string;
    var filterType = opts.filterOut.type;
    var copy = this.copy();
    for(;;) {
      var existsNext = copy.next();
      var next = copy.cur();
      if (filterString && existsNext && next && next.string.match(filterString)) {
        continue;
      } else if (filterType && existsNext && next && next.type.match(filterType)) {
        continue;
      }
      return (existsNext && next && next.string.match(string) && next.type.match(type));
    }
  };

  /**
   *
   * @param {Object} [opts] Predicate criteria ( uses opts.string and opts.type )
   * @returns {boolean} Whether the previous token in the stream meets
   * the criteria in opts
   */
  TokenTape.prototype.prevMatches = function(opts) {
    opts = opts || {};
    opts.filterOut = opts.filterOut || {};
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var filterString = opts.filterOut.string;
    var filterType = opts.filterOut.type;
    var copy = this.copy();
    for(;;) {
      var existsPrev = copy.prev();
      var prev = copy.cur();
      if (filterString && existsPrev && prev && prev.string.match(filterString)) {
        continue;
      } else if (filterType && existsPrev && prev && prev.type.match(filterType)) {
        continue;
      }
      return (existsPrev && prev && prev.string.match(string) && prev.type.match(type));
    }
  };

  /**
   * Checks if the TokenTape is currently on a
   * sub-keyword sequence as defined by SEQSUBKEYWORDS
   * @param [opts]
   * @returns {Object} A mapping of potential keyword matches, if any
   */
  TokenTape.prototype.checkSequence = function(opts) {
    opts = opts || {};
    var dir = opts.dir || 1;
    var offset = opts.offset || 0;
    var seqs = SEQSUBKEYWORDS;
    if (opts.kw) {
      var tmp = seqs[opts.kw];
      seqs = {};
      seqs[opts.kw] = tmp;
    }
    var copy = this.copy();
    var criteria = {string: /[^\s]+/};
    while (offset > 0) { copy.next(); offset--; }
    while (offset < 0) { copy.prev(); offset++; }
    var fstTok = (dir === 1) ? copy.findNext(criteria) : copy.findPrev(criteria);
    var sndTok = (dir === 1) ? copy.findNext(criteria) : copy.findPrev(criteria);
    if (!fstTok || FLAT_SEQ.indexOf(fstTok.string) === -1) return null;
    if (!sndTok || FLAT_SEQ.indexOf(sndTok.string) === -1) return null;
    if (!(fstTok.type === "keyword" && sndTok.type === "keyword")) return null;
    if (dir != 1) {
      var temp = sndTok;
      sndTok = fstTok;
      fstTok = temp;
    }
    function doCheck(seq) {
      if (!Array.isArray(seq) || seq.length === 0) return null;
      if (seq.length > 2) {
        console.warn("Cannot have subkeyword sequences longer than length 2");
        return null;
      }
      if (seq[0] === fstTok.string && seq[1] === sndTok.string) {
        return {from: Pos(fstTok.line, fstTok.start), to: Pos(sndTok.line, sndTok.end)};
      }
      return null;
    }
    var collected = {};
    var any = false;
    Object.keys(SEQSUBKEYWORDS).forEach(function(key) {
      var seqs = SEQSUBKEYWORDS[key];
      seqs.forEach(function(seq) {
        var res = doCheck(seq);
        if (res) {
          any = true;
          collected[key] = collected[key] || [];
          collected[key].push(res);
        }
      });
    });
    return any ? collected : null;
  };

  var elseIfFilter = {type: /keyword/, string: /else/,
    filterOut: {string: /\s+/}};

  function IterResult(token, fail, subs) {
    this.token = token;
    this.fail = fail;
    this.subs = subs || [];
  }

  /**
   * Finds the closing keyword which matches the
   * token at the current position
   *
   * @param {string} [kw] - The keyword to match
   * @returns {IterResult} The resulting matched closing keyword
   */
  TokenTape.prototype.findMatchingClose = function(kw) {
    var stack = [];
    var subs = {};
    var skip = 0;
    for (;;) {
      var next = this.findNext({type: /builtin|keyword/});
      if (!next) return new IterResult(null, false, kw ? subs[kw] : []);
      if (skip > 0) { skip--; continue; }
      if (stack.length === 0 && INV_SIMPLESUBKEYWORDS[next.string]) {
        INV_SIMPLESUBKEYWORDS[next.string].forEach(function(key) {
          subs[key] = subs[key] || [];
          subs[key].push({from: Pos(next.line, next.start), to: Pos(next.line, next.end)});
        });
      }
      if (isClosing(next)) {
        if (stack.length === 0) {
          var tok = {keyword: next,
            from: Pos(next.line, next.start),
            to: Pos(next.line, next.end)};
          var fail = !(!kw || keyMatches(kw, next));
          return new IterResult(tok, fail, (fail || !kw) ? [] : subs[kw]);
        } else {
          stack.pop();
        }
      } else if (next.string === "if") {
        stack.push(next);
      } else if (isOpening(next)) {
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
    var stack = [];
    var subs = {};
    var skip = 0;
    for (;;) {
      var prev = this.findPrev({type: /builtin|keyword/});
      console.log(prev);
      if (!prev) return new IterResult(null, true);
      if (skip > 0) { skip--; continue; }

      
      if (stack.length === 0 && INV_SIMPLESUBKEYWORDS[prev.string]) {
        INV_SIMPLESUBKEYWORDS[prev.string].forEach(function(key) {
          subs[key] = subs[key] || [];
          subs[key].push({from: Pos(prev.line, prev.start), to: Pos(prev.line, prev.end)});
        });
      }
      if (isClosing(prev)) {
        stack.push(prev);
      } else if (isOpening(prev)) {
        if (stack.length === 0) {
          var tok = { keyword: prev.string,
            from: Pos(prev.line, prev.start),
            to: Pos(prev.line, prev.end) };
          var fail = !(!kw || keyMatches(prev, kw));
          return new IterResult(tok, fail, (fail || !kw) ? [] : subs[prev.string]);
        }
        // Stack is nonempty
        stack.pop();
      }
    }
  };

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

  CodeMirror.registerHelper("fold", "pyret", function(cm, start) {
    var tstream = new TokenTape(cm, start.line, 0);
    for (;;) {
      var openKw = tstream.findNext({type: /keyword|builtin/, string: delimrx});
      if (!openKw) return;
      if (isOpening(openKw)) {
        var startKw = Pos(openKw.line, openKw.end);
        if (openKw.string === 'fun') {
          var tmp = tstream.copy().next();
          if (tmp && tmp.type === 'function-name')
            startKw = Pos(tmp.line, tmp.end);
        }
        var close = tstream.findMatchingClose(openKw.string);
        return close && {from: startKw, to: close.token.from};
      }
    }
  });

  CodeMirror.findMatchingKeyword = function(cm, pos, range) {
    initHandler(cm);
    // No special words on the current line
    var tstream = new TokenTape(cm, pos.line, pos.ch, range);
    var start = tstream.findAdjacent({type: /keyword|builtin/, string: delimrx, pos: pos});
    // Putting these three keywords in the delimrx regular expression breaks
    // invariants elsewhere...they are subkeywords, so kept separate
    if (!start) {
      tstream = new TokenTape(cm, pos.line, pos.ch, range);
      start = tstream.findAdjacent({type: /keyword|builtin/, string: /else|where|sharing/, pos: pos});
    }
    if (!start || cmp(Pos(start.line, start.start), pos) > 0) return;
    var here = {from: Pos(start.line, start.start), to: Pos(start.line, start.end)};
    var other;
    console.log(start);
    if (isClosing(start.string)) {
      //tstream.prev(); // Push back one word to line up correctly
      other = tstream.findMatchingOpen(start.string);
      return {open: other.token, close: here, at: "close", matches: !other.fail, extra: other.subs};
    } else if (Object.keys(INV_SIMPLESUBKEYWORDS).indexOf(start.string) != -1) {
      parent = tstream.findMatchingParent(start.string);
      if (parent.fail) {
        return {open: parent.token, close: here, at: "open", matches: false, extra: []};
      }
      return CodeMirror.findMatchingKeyword(cm, Pos(parent.token.line, parent.token.start), range);
    } else if (!tstream.checkSequence({offset: -2, dir: 1})) {
      other = tstream.findMatchingClose(start.string);
      return {open: here, close: other.token, at: "open", matches: !other.fail, extra: other.subs};
    }
  };

  CodeMirror.findEnclosingKeyword = function(cm, pos, range) {
    var tstream = new TokenTape(cm, pos.line, pos.ch, range);
    for (;;) {
      var open = tstream.findMatchingOpen(null).token;
      if (!open) break;
      var close = tstream.findMatchingClose(open.keyword);
      if (close && close.token) return {open: open, close: close.token,
        matches: !close.fail, extra: close.subs};
    }
  };
});

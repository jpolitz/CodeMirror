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

  var DELIMS;
  var ENDDELIM;
  var SPECIALDELIM;
  var ALLDELIMS;
  var delimrx;


  CodeMirror.defineOption("PyretDelimiters", {opening: [], closing: []},
    function(editor, newVal) {
      DELIMS = newVal.opening;
      ENDDELIM = newVal.closing;
      SPECIALDELIM = [{start: "(", end: ")"},
        {start: "[", end: "]"},
        {start: "{", end: "}"}];
      ALLDELIMS = [].concat(DELIMS,ENDDELIM,"(",")","[","]","{","}");

      delimrx = new RegExp("(" + DELIMS.join("|") + "|" +
        ENDDELIM.join("|") + "|\\(|\\)|\\[|\\]|{|})", "g");
    });



  var SIMPLESUBKEYWORDS = {
    "if": ["else"], "fun": ["where"],
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
  function TokenStream(cm, line, ch, range) {
    this.line = line;
    this.cm = cm;
    this.text = cm.getLine(line);
    this.min = range ? range.from : cm.firstLine();
    this.max = range ? range.to - 1 : cm.lastLine();
    var curTok = cm.getTokenAt(Pos(line, ch));
    this.current = {start: curTok.start, end: curTok.end};
  }

  /**
   * Duplicates this {@link TokenStream} object
   * @returns {TokenStream} the duplicated object
   */
  TokenStream.prototype.copy = function() {
    return new TokenStream(this.cm,
      this.line,
      this.current.start,
      {from: this.min, to: this.max});
  };

  /**
   * Moves this {@link TokenStream} to the next line
   * @returns {boolean} Whether the move was successful
   */
  TokenStream.prototype.nextLine = function() {
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
   * Moves this {@link TokenStream} to the previous line
   * @returns {boolean} Whether the move was successful
   */
  TokenStream.prototype.prevLine = function() {
    if (this.line <= this.min) {
      this.current.start = null;
      return false;
    }
    this.text = this.cm.getLine(--this.line);
    var last = this.cm.getLineTokens(this.line);
    // FIXME: Only one of these two checks should be needed
    // check if getLineTokens failed or is empty (if so, try prior line)
    if (!last || last.length === 0) return this.prevLine();
    last = last[last.length - 1];
    // Empty line
    if ((last.start === 0) && (last.end === 0)) return this.prevLine();
    this.current.start = last.start;
    this.current.end = last.end;
    return true;
  };

  /**
   * EFFECTS: Advances the {@link TokenStream}
   *  to the next token
   * @returns {Object} The next token in the stream
   */
  TokenStream.prototype.next = function() {
    var tok;
    if (this.current.end === null) return null;
    else if (this.current.start === null) {
      tok = this.cm.getTokenAt(Pos(this.line, this.current.end));
      tok.line = this.line;
      this.current.start = tok.start;
      this.current.end = tok.end;
      return tok;
    }
    tok = this.cm.getTokenAt(Pos(this.line, this.current.start + 1));
    tok.line = this.line;
    var nextTok = this.cm.getTokenAt(Pos(this.line, this.current.end + 1));
    // End of line
    if (nextTok.start === this.current.start) {
      this.nextLine();
    } else {
      this.current.start = nextTok.start;
      this.current.end = nextTok.end;
    }
    return tok;
  };

  /**
   * Like {@link TokenStream#next}, but doesn't advance the stream
   * @returns {Object} The next token in the stream
   */
  TokenStream.prototype.peekNext = function() {
    if (this.current.end === null) return null;
    var tok = this.cm.getTokenAt(Pos(this.line, this.current.start + 1));
    tok.line = this.line;
    return tok;
  };

  /**
   * Be advised that
   * TokenStream.prev() == TokenStream.next()
   * (they are intensionally distinct, but
   *  logically the same)
   *
   * EFFECTS: Advances the {@link TokenStream}
   *  to the previous token
   * @returns {Object} The previous token in the stream
   */
  TokenStream.prototype.prev = function() {
    var tok;
    if (this.current.start === null) return null;
    else if (this.current.end === null) {
      tok = this.cm.getTokenAt(Pos(this.line, this.current.start + 1));
      tok.line = this.line;
      this.current.start = tok.start;
      this.current.end = tok.end;
      return tok;
    }

    if (this.current.start === 0) {
      // prevLine mutates this.current
      if (!this.prevLine()) return null;
      tok = this.cm.getTokenAt(Pos(this.line, this.current.start + 1));
    } else {
      tok = this.cm.getTokenAt(Pos(this.line, this.current.start));
      this.current.start = tok.start;
      this.current.end = tok.end;
    }
    tok.line = this.line;
    return tok;
  };

  /**
   * Like {@link TokenStream#prev}, but doesn't move back the stream
   * @returns {Object} The previous token in the stream
   */
  TokenStream.prototype.peekPrev = function() {
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
  TokenStream.prototype.findNext = function(opts) {
    opts = opts || {};
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var next;
    while(next = this.next()) {
      if (next.string.match(string) && next.type && next.type.match(type)) return next;
    }
    return null;
  };

  /**
   * Finds the previous token in the stream which matches the
   * given criteria
   * @param {Object} [opts] The search criteria ( uses opts.string and opts.type )
   * @returns {Object} The matching token, if any
   */
  TokenStream.prototype.findPrev = function(opts) {
    opts = opts || {};
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var prev;
    while(prev = this.prev()) {
      if (prev.string.match(string) && prev.type && prev.type.match(type)) return prev;
    }
    return null;
  };

  /**
   *
   * @param {Object} [opts] Predicate criteria ( uses opts.string and opts.type )
   * @returns {boolean} Whether the next token in the stream meets
   * the criteria in opts
   */
  TokenStream.prototype.nextMatches = function(opts) {
    opts = opts || {};
    opts.filterOut = opts.filterOut || {};
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var filterString = opts.filterOut.string;
    var filterType = opts.filterOut.type;
    var copy = this.copy();
    for(;;) {
      var next = copy.next();
      if (filterString && next && next.string.match(filterString)) {
        continue;
      } else if (filterType && next && next.type.match(filterType)) {
        continue;
      }
      return (next && next.string.match(string) && next.type.match(type));
    }
  };

  /**
   *
   * @param {Object} [opts] Predicate criteria ( uses opts.string and opts.type )
   * @returns {boolean} Whether the previous token in the stream meets
   * the criteria in opts
   */
  TokenStream.prototype.prevMatches = function(opts) {
    opts = opts || {};
    opts.filterOut = opts.filterOut || {};
    var string = opts.string || new RegExp(".*");
    var type = opts.type || new RegExp(".*");
    var filterString = opts.filterOut.string;
    var filterType = opts.filterOut.type;
    var copy = this.copy();
    for(;;) {
      var prev = copy.prev();
      if (filterString && prev && prev.string.match(filterString)) {
        continue;
      } else if (filterType && prev && prev.type.match(filterType)) {
        continue;
      }
      return (prev && prev.string.match(string) && prev.type.match(type));
    }
  };

  /**
   * Checks if the TokenStream is currently on a
   * sub-keyword sequence as defined by SEQSUBKEYWORDS
   * @param [opts]
   * @returns {Object} A mapping of potential keyword matches, if any
   */
  TokenStream.prototype.checkSequence = function(opts) {
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
  TokenStream.prototype.findMatchingClose = function(kw) {
    var stack = [];
    var subs = {};
    var seqOpts = {offset: -1, dir: 1};
    var skip = 0;
    if (kw) seqOpts[kw] = kw;
    for (;;) {
      var next = this.findNext({type: /builtin|keyword/});
      if (!next) return new IterResult(null, false, kw ? subs[kw] : []);
      if (skip > 0) { skip--; continue; }
      var maybeSeq = this.checkSequence(seqOpts);
      if (maybeSeq) {
        skip++;
        Object.keys(maybeSeq).forEach(function(key) {
          subs[key] = subs[key] || [];
          subs[key] = subs[key].concat(maybeSeq[key]);
        });
      } else if (INV_SIMPLESUBKEYWORDS[next.string]) {
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
        var isElseif = this.prevMatches(elseIfFilter);
        if (!isElseif) stack.push(next);
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
  TokenStream.prototype.findMatchingOpen = function(kw) {
    var stack = [];
    var subs = {};
    var skip = 0;
    for (;;) {
      var prev = this.findPrev({type: /builtin|keyword/});
      if (!prev) return new IterResult(null, true);
      if (skip > 0) { skip--; continue; }

      if (isClosing(prev)) {
        stack.push(prev);
      }
      var maybeSeq = this.checkSequence({offset: 2, dir: -1});
      if (maybeSeq) {
        skip++;
        Object.keys(maybeSeq).forEach(function(key) {
          subs[key] = subs[key] || [];
          subs[key] = subs[key].concat(maybeSeq[key]);
        });
      } else if (INV_SIMPLESUBKEYWORDS[prev.string]) {
        INV_SIMPLESUBKEYWORDS[prev.string].forEach(function(key) {
          subs[key] = subs[key] || [];
          subs[key].push({from: Pos(prev.line, prev.start), to: Pos(prev.line, prev.end)});
        });
      } else if (isOpening(prev)) {
        if (prev.string === 'if') {
          var isElseif = this.prevMatches(elseIfFilter);
          if (isElseif) continue;
        }
        if (stack.length === 0) {
          var tok = { keyword: prev.string,
            from: Pos(prev.line, prev.start),
            to: Pos(prev.line, prev.end) };
          var fail = !(!kw || keyMatches(prev, kw));
          return new IterResult(tok, fail, fail ? [] : subs[prev.string]);
        }
        // Stack is nonempty
        stack.pop();
      }
    }
  };

  CodeMirror.registerHelper("fold", "pyret", function(cm, start) {
    var tstream = new TokenStream(cm, start.line, 0);
    for (;;) {
      var openKw = tstream.findNext({type: /keyword|builtin/, string: delimrx});
      if (!openKw) return;
      if (isOpening(openKw) && !tstream.checkSequence({offset: -2, dir: 1})) {
        var startKw = Pos(openKw.line, openKw.end);
        if (openKw.string === 'fun') {
          var tmp = tstream.copy().findNext({string: /[^\s]+/});
          if (tmp && tmp.type === 'function-name')
            startKw = Pos(tmp.line, tmp.end);
        }
        var close = tstream.findMatchingClose(openKw.string);
        return close && {from: startKw, to: close.token.from};
      }
    }
  });

  CodeMirror.findMatchingKeyword = function(cm, pos, range) {
    //var iter = new Iter(cm, pos.line, pos.ch, range);
    // No special words on the current line
    var tstream = new TokenStream(cm, pos.line, pos.ch, range);
    if (indexOf(tstream.text, ALLDELIMS).index == -1) return;
    var start = tstream.findNext({type: /keyword|builtin/, string: delimrx});
    if (!start || cmp(Pos(start.line, start.start), pos) > 0) return;
    var here = {from: Pos(start.line, start.start), to: Pos(start.line, start.end)};
    var other;
    if (isClosing(start.string)) {
      tstream.prev(); // Push back one word to line up correctly
      other = tstream.findMatchingOpen(start.string);
      return {open: other.token, close: here, at: "close", matches: !other.fail, extra: other.subs};
    } else if (!tstream.checkSequence({offset: -2, dir: 1})) {
      other = tstream.findMatchingClose(start.string);
      return {open: here, close: other.token, at: "open", matches: !other.fail, extra: other.subs};
    }
  };

  CodeMirror.findEnclosingKeyword = function(cm, pos, range) {
    var tstream = new TokenStream(cm, pos.line, pos.ch, range);
    for (;;) {
      var open = tstream.findMatchingOpen(null).token;
      if (!open) break;
      var close = tstream.findMatchingClose(open.keyword);
      if (close && close.token) return {open: open, close: close.token,
        matches: !close.fail, extra: close.subs};
    }
  };
});

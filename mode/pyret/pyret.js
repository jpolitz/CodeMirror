CodeMirror.defineMode("pyret", function(config, parserConfig) {
  var ERRORCLASS = 'error';
  function wordRegexp(words) {
    return new RegExp("^((" + words.join(")|(") + "))\\b");
  }
  
  const pyret_indent_regex = new RegExp("^[a-zA-Z_][a-zA-Z0-9$_\\-]*");
  const pyret_keywords = 
    wordRegexp(["fun", "method", "var", "when", "import", "provide", 
                "data", "end", "except", "for", "from", 
                "and", "or", "not", "as"]);
  const pyret_keywords_colon = 
    wordRegexp(["doc", "try", "with", "sharing", "check", "case"]);
  const pyret_single_punctuation = 
    new RegExp("^([" + ["\\:", "\\.", "<", ">", ",", "^", 
                        ";", "|", "=", "+", "*", "/", "\\", // NOTE: No minus
                        "\\(", "\\)", "{", "}", "\\[", "\\]"].join('') + "])");
  const pyret_double_punctuation = 
    new RegExp("^((" + ["::", "==", ">=", "<=", "=>", "->", ":=", "<>"].join(")|(") + "))");
  const initial_operators = { "-": true, "+": true, "*": true, "/": true, "<": true, "<=": true,
                              ">": true, ">=": true, "==": true, "<>": true, ".": true, "^": true }
  
  
  var lastToken = null, lastContent = null;
  function ret(tokType, content, style) {
    lastToken = tokType; lastContent = content;
    return style;
  }

  function tokenBase(stream, state) { 
    if (stream.eatSpace())
      return "IGNORED-SPACE";

    var ch = stream.peek();
    

    // Handle Comments
    if (ch === '#') {
      stream.skipToEnd();
      return ret(lastTok, lastContent, 'comment');
    }
    // Handle Number Literals
    if (stream.match(/^[0-9]+(\.[0-9]+)?/))
      return ret('number', stream.current(), 'number');
    
    if (ch === '"') {
      state.tokenizer = tokenString;
      lastToken = '"';
      stream.eat('"');
      return state.tokenizer(stream, state);
    }
    // Level 1
    var match;
    if ((match = stream.match(pyret_double_punctuation, true)) || 
        (match = stream.match(pyret_single_punctuation, true))) {
      return ret(match[0], match[0], 'builtin');
    }
    if (match = stream.match(pyret_keywords, true)) {
      return ret(match[0], match[0], 'keyword');
    }
    if (match = stream.match(pyret_keywords_colon, true)) {
      if (stream.peek() === ":")
        return ret(match[0], match[0], 'keyword');
      else
        return ret('name', match[0], 'variable');
    }
    // Level 2
    if (match = stream.match(pyret_indent_regex)) {
      if (lastToken === "|") {
        if (match[0] === "else")
          return ret(match[0], match[0], 'keyword');
        else if (stream.match(/\s*\(/, false))
          return ret('name', match[0],'function-name');
        else if (stream.match(/\s*=>/, false))
          return ret('name', match[0], 'variable');
        else if (stream.match(/\s*($|with\b|\()/, false))
          return ret('name', match[0], 'type');
      } else if (lastToken === "::")
        return ret('name', match[0], 'type');
      else if (lastToken === "data")
        return ret('name', match[0], 'type');
      else if (stream.match(/\s*\(/, false))
        return ret('name', match[0], 'function-name');
      return ret('name', match[0], 'variable');
    }
    if (stream.eat("-"))
      return ret('-', '-', 'builtin');
    stream.next();
    return null;
  }
  function tokenString(stream, state) { 
    while (!stream.eol()) {
      stream.eatWhile(/[^"\\]/);
      if (stream.eat('\\')) {
        stream.next();
        if (stream.eol())
          return ret('string', stream.current(), 'string');
      } else if (stream.eat('"')) {
        state.tokenizer = tokenBase;
        return ret('string', stream.current(), 'string');
      } else
        stream.eat(/"/);
    }
    return ret('string', stream.current(), 'string');
  }

  // Parsing

  function Indent(funs, cases, data, shared, trys, except, parens, objects, vars, fields, initial) {
    this.fn = funs || 0;
    this.c = cases || 0;
    this.d = data || 0;
    this.s = shared || 0;
    this.t = trys || 0;
    this.e = except || 0;
    this.p = parens || 0;
    this.o = objects || 0;
    this.v = vars || 0;
    this.f = fields || 0;
    this.i = initial || 0;
  }
  Indent.prototype.toString = function() {
    return ("Fun " + this.fn + ", Cases " + this.c + ", Data " + this.d + ", Shared " + this.s
            + ", Try " + this.t + ", Except " + this.e + ", Parens " + this.p 
            + ", Object " + this.o + ", Vars " + this.v + ", Fields " + this.f + ", Initial " + this.i);
  }
  Indent.prototype.copy = function() {
    return new Indent(this.fn, this.c, this.d, this.s, this.t, this.e, this.p, this.o, this.v, this.f, this.i);
  }
  Indent.prototype.zeroOut = function() {
    this.fn = this.c = this.d = this.s = this.t = this.e = this.p = this.o = this.v = this.f = this.i = 0;
  }
  Indent.prototype.addSelf = function(that) {
    this.fn += that.fn; this.c += that.c; this.d += that.d; this.s += that.s; this.t += that.t;
    this.e += that.e; this.p += that.p; this.o += that.o; this.v += that.v; this.f += that.f; this.i += that.i;
    return this;
  }
  Indent.prototype.add = function(that) { return this.copy().addSelf(that); }
  Indent.prototype.subSelf = function(that) {
    this.fn -= that.fn; this.c -= that.c; this.d -= that.d; this.s -= that.s; this.t -= that.t;
    this.e -= that.e; this.p -= that.p; this.o -= that.o; this.v -= that.v; this.f -= that.f; this.i -= that.i;
    return this;
  }
  Indent.prototype.sub = function(that) { return this.copy().subSelf(that); }

  function LineState(tokens,
                     nestingsOpenFromPrevLine, nestingsFromPrevLine,
                     deferedOpened, curOpened, deferedClosed, curClosed) {
    this.tokens = tokens;
    this.nestingsOpenFromPrevLine = nestingsOpenFromPrevLine;
    this.nestingsFromPrevLine = nestingsFromPrevLine;
    this.deferedOpened = deferedOpened;
    this.curOpened = curOpened;
    this.deferedClosed = deferedClosed;
    this.curClosed = curClosed;
  }
  LineState.prototype.copy = function() {
    return new LineState(this.tokens.concat([]),
                         this.nestingsOpenFromPrevLine.copy(), this.nestingsFromPrevLine.copy(),
                         this.deferedOpened.copy(), this.curOpened.copy(), 
                         this.deferedClosed.copy(), this.curClosed.copy());
  }
  LineState.prototype.print = function() {
    console.log("LineState for token " + lastToken + " is:");
    console.log("  NestingsOpenFromPrevLine = " + this.nestingsOpenFromPrevLine);
    console.log("  NestingsFromPrevLine = " + this.nestingsFromPrevLine);
    console.log("  DeferedOpened = " + this.deferedOpened);
    console.log("  DeferedClosed = " + this.deferedClosed);
    console.log("  CurOpened = " + this.curOpened);
    console.log("  CurClosed = " + this.curClosed);
    console.log("  Tokens = " + this.tokens);
  }

  function peek(arr) { return arr[arr.length - 1]; }
  function hasTop(arr, wanted) {
    if (wanted instanceof Array) {
      for (var i = 0; i < wanted.length; i++) {
        if (arr[arr.length - 1 - i] !== wanted[i]) {
          return false;
        }
      }
      return true;
    } else {
      return arr[arr.length - 1] === wanted;
    }
  }
  function parse(firstTokenInLine, state, stream, style) {
    ls = state.lineState;
    if (firstTokenInLine && hasTop(ls.tokens, "NEEDSOMETHING")) {
      ls.tokens.pop();
      if (hasTop(ls.tokens, "VAR") && ls.deferedOpened.v > 0) {
        ls.deferedOpened.v--;
        ls.tokens.pop();
      }
    } else if (firstTokenInLine && initial_operators[lastToken]) {
      ls.curOpened.i++;
      ls.deferedClosed.i++;
    } else if (lastToken === ":") {
      if (hasTop(ls.tokens, "WANTCOLON") || hasTop(ls.tokens, "WANTCOLONOREQUAL"))
        ls.tokens.pop();
      if (hasTop(ls.tokens, "OBJECT") || hasTop(ls.tokens, "SHARED")) {
        ls.deferedOpened.f++;
        ls.tokens.push("FIELD", "NEEDSOMETHING");
      }
    } else if (lastToken === ",") {
      if (hasTop(ls.tokens, "FIELD")) {
        ls.tokens.pop();
        if (ls.curOpened.f > 0) ls.curOpened.f--;
        else if (ls.deferedOpened.f > 0) ls.deferedOpened.f--;
        else ls.deferedClosed.f++;
      }
    } else if (lastToken === "=") {
      if (hasTop(ls.tokens, "WANTCOLONOREQUAL")) 
        ls.tokens.pop();
      else {
        while (hasTop(ls.tokens, "VAR")) {
          ls.tokens.pop();
          ls.curClosed.v++;
        }
      }
      ls.deferedOpened.v++;
      ls.tokens.push("VAR", "NEEDSOMETHING");
    } else if (lastToken === "var") {
      ls.deferedOpened.v++;
      ls.tokens.push("VAR", "NEEDSOMETHING", "WANTCOLONOREQUAL");
    } else if (lastToken === "fun" || lastToken === "method") {
      ls.deferedOpened.fn++;
      ls.tokens.push("FUN", "WANTOPENPAREN");
    } else if (lastToken === "when") {
      ls.deferedOpened.fn++; // when indents like functions
      ls.tokens.push("WHEN", "WANTCOLON");
    } else if (lastToken === "for") {
      ls.deferedOpened.fn++; // for-loops indent like functions
      ls.tokens.push("FOR", "WANTCOLON");
    } else if (lastToken === "case") {
      ls.deferedOpened.c++;
      ls.tokens.push("CASE", "WANTCOLON");
    } else if (lastToken === "data") {
      ls.deferedOpened.d++;
      ls.tokens.push("DATA", "WANTCOLON", "NEEDSOMETHING");
    } else if (lastToken === "|") {
      if (hasTop(ls.tokens, ["OBJECT", "DATA"]) || hasTop(ls.tokens, ["FIELD", "OBJECT", "DATA"])) {
        ls.curClosed.o++;
        if (hasTop(ls.tokens, "FIELD")) {
          ls.tokens.pop();
          if (ls.curOpened.f > 0) ls.curOpened.f--;
          else if (ls.deferedOpened.f > 0) ls.deferedOpened.f--;
          else ls.curClosed.f++;
        }
        if (hasTop(ls.tokens, "OBJECT"))
          ls.tokens.pop();
      } else if (hasTop(ls.tokens, "DATA"))
        ls.tokens.push("NEEDSOMETHING");
    } else if (lastToken === "with") {
      if (hasTop(ls.tokens, ["WANTOPENPAREN", "WANTCLOSEPAREN", "DATA"])) {
        ls.tokens.pop(); ls.tokens.pop();
        ls.deferedOpened.o++;
        ls.push("OBJECT", "WANTCOLON");
      }
    } else if (lastToken === "provide") {
      ls.tokens.push("PROVIDE");
    } else if (lastToken === "sharing") {
      ls.curClosed.d++; ls.deferedOpened.s++;
      if (hasTop(ls.tokens, ["OBJECT", "DATA"])) {
        ls.tokens.pop(); ls.tokens.pop();
        ls.curClosed.o++;
        ls.push("SHARED", "WANTCOLON");
      } else if (hasTop(ls.tokens, "DATA")) {
        ls.tokens.pop();
        ls.push("SHARED", "WANTCOLON");
      }
    } else if (lastToken === "check") {
      if (hasTop(ls.tokens, ["OBJECT", "DATA"])) {
        ls.tokens.pop();
        ls.curClosed.o++; ls.curClosed.d++; ls.deferedOpened.s++;
      } else if (hasTop(ls.tokens, "FUN")) {
        ls.curClosed.f++; ls.deferedOpened.s++;
      } else if (hasTop(ls.tokens, "SHARED")) {
        ls.curClosed.s++; ls.deferedOpened.s++;
      }
      ls.tokens.pop();
      ls.tokens.push("CHECK", "WANTCOLON");
    } else if (lastToken === "try") {
      ls.deferedOpened.t++;
      ls.tokens.push("TRY", "WANTCOLON");
    } else if (lastToken === "except") {
      if (ls.curOpened.t > 0) ls.curOpened.t--;
      else if (ls.deferedOpened.t > 0) ls.deferedOpened.t--;
      else ls.curClosed.t++;
      if (hasTop(ls.tokens, "TRY")) {
        ls.tokens.pop();
        ls.tokens.push("WANTCOLON", "WANTCLOSEPAREN", "WANTOPENPAREN");
      }
    } else if (lastToken === "[") {
      ls.deferedOpened.o++;
      ls.tokens.push("ARRAY");
    } else if (lastToken === "]") {
      if (firstTokenInLine) ls.curClosed.o++;
      else ls.deferedClosed.o++;
      if (hasTop(ls.tokens, "ARRAY"))
        ls.tokens.pop();
      while (hasTop(ls.tokens, "VAR")) {
        ls.tokens.pop();
        ls.deferedClosed.v++;
      }
    } else if (lastToken === "{") {
      ls.deferedOpened.o++;
      ls.tokens.push("OBJECT");
    } else if (lastToken === "}") {
      if (firstTokenInLine) ls.curClosed.o++;
      else ls.deferedClosed.o++;
      if (hasTop(ls.tokens, "FIELD")) {
        ls.tokens.pop();
        if (ls.curOpened.f > 0) ls.curOpened.f--;
        else if (ls.deferedOpened.f > 0) ls.deferedOpened.f--;
        else ls.curClosed.f++;
      }
      if (hasTop(ls.tokens, "OBJECT"))
        ls.tokens.pop();
      while (hasTop(ls.tokens, "VAR")) {
        ls.tokens.pop();
        ls.deferedClosed.v++;
      }
    } else if (lastToken === "(") {
      ls.deferedOpened.p++;
      if (hasTop(ls.tokens, "WANTOPENPAREN")) {
        ls.tokens.pop();
      } else if (hasTop(ls.tokens, "OBJECT") || hasTop(ls.tokens, "SHARED")) {
        ls.tokens.push("FUN");
        ls.deferedOpened.f++;
      } else {
        ls.tokens.push("WANTCLOSEPAREN");
      }
    } else if (lastToken === ")") {
      ls.deferedClosed.p++;
      if (hasTop(ls.tokens, "WANTCLOSEPAREN"))
        ls.tokens.pop();
      while (hasTop(ls.tokens, "VAR")) {
        ls.tokens.pop();
        ls.deferedClosed.v++;
      }
    } else if (lastToken === "end") {
      if (hasTop(ls.tokens, ["OBJECT", "DATA"])) {
        ls.curClosed.o++;
        ls.tokens.pop();
      }
      var top = peek(ls.tokens);
      var stillUnclosed = true;
      while (stillUnclosed && ls.tokens.length) {
        // Things that are not counted at all:
        //   provide, wantcolon, wantcolonorequal, needsomething, wantopenparen
        // Things that are counted but not closable by end:
        if (top === "OBJECT" || top === "ARRAY") {
          if (ls.curOpened.o > 0) ls.curOpened.o--;
          else if (ls.deferedOpened.o > 0) ls.deferedOpened.o--;
          else ls.curClosed.o++;
        } else if (top === "WANTCLOSEPAREN") {
          if (ls.curOpened.p > 0) ls.curOpened.p--;
          else if (ls.deferedOpened.p > 0) ls.deferedOpened.p--;
          else ls.curClosed.p++;
        } else if (top === "FIELD") {
          if (ls.curOpened.f > 0) ls.curOpened.f--;
          else if (ls.deferedOpened.f > 0) ls.deferedOpened.f--;
          else ls.curClosed.f++;
        } else if (top === "VAR") {
          if (ls.curOpened.v > 0) ls.curOpened.v--;
          else if (ls.deferedOpened.v > 0) ls.deferedOpened.v--;
          else ls.curClosed.v++;
        } 
        // Things that are counted, and closable by end:
        else if (top === "FUN" || top === "WHEN" || top === "FOR") {
          if (ls.curOpened.fn > 0) ls.curOpened.fn--;
          else if (ls.deferedOpened.fn > 0) ls.deferedOpened.fn--;
          else ls.curClosed.fn++;
          stillUnclosed = false;
        } else if (top === "CASEs") {
          if (ls.curOpened.c > 0) ls.curOpened.c--;
          else if (ls.deferedOpened.c > 0) ls.deferedOpened.c--;
          else ls.curClosed.c++;
          stillUnclosed = false;
        } else if (top === "DATA") {
          if (ls.curOpened.d > 0) ls.curOpened.d--;
          else if (ls.deferedOpened.d > 0) ls.deferedOpened.d--;
          else ls.curClosed.d++;
          stillUnclosed = false;
        } else if (top === "SHARED" || top === "CHECK") {
          if (ls.curOpened.s > 0) ls.curOpened.s--;
          else if (ls.deferedOpened.s > 0) ls.deferedOpened.s--;
          else ls.curClosed.s++;
          stillUnclosed = false;
        } else if (top === "TRY") {
          if (ls.curOpened.t > 0) ls.curOpened.t--;
          else if (ls.deferedOpened.t > 0) ls.deferedOpened.t--;
          else ls.curClosed.t++;
          stillUnclosed = false;
        } else if (top === "EXCEPT") {
          if (ls.curOpened.e > 0) ls.curOpened.e--;
          else if (ls.deferedOpened.e > 0) ls.deferedOpened.e--;
          else ls.curClosed.e++;
          stillUnclosed = false;
        } 
        ls.tokens.pop();
        top = peek(ls.tokens);
      }
    }

    if (stream.match(/\s*$/, false)) { // End of line; close out nestings fields
      console.log("We think we're at an end of line");
      console.log("LineState is currently");
      ls.print();
      ls.nestingsOpenFromPrevLine = ls.nestingsFromPrevLine.add(ls.curOpened).subSelf(ls.curClosed);
      while (hasTop(ls.tokens, "VAR")) {
        ls.tokens.pop();
        ls.curClosed.v++;
      }
      ls.nestingsFromPrevLine.addSelf(ls.curOpened).addSelf(ls.deferedOpened)
        .subSelf(ls.curClosed).subSelf(ls.deferedClosed);
      ls.tokens = ls.tokens.concat([]);
      ls.curOpened.zeroOut(); ls.deferedOpened.zeroOut();
      ls.curClosed.zeroOut(); ls.deferedClosed.zeroOut();
    }
    console.log("LineState is now");
    ls.print();
  }


  const INDENTATION = new Indent(1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1);

  function copyState(oldState) {
    return { tokenizer: oldState.tokenizer, lineState: oldState.lineState.copy() }
  }
  
  function indent(state, textAfter) {
    var indentUnit = config.indentUnit;
    var taSS = new CodeMirror.StringStream(textAfter, config.tabSize);
    var sol = true;
    state = copyState(state);
    while (!taSS.eol()) {
      var style = state.tokenizer(taSS, state);
      parse(sol, state, taSS, style);
      sol = false;
    }
    console.log("***** In indent");
    state.lineState.print();
    var indentSpec = state.lineState.nestingsFromPrevLine;
    var indent = 0;
    for (var key in INDENTATION) {
      if (INDENTATION.hasOwnProperty(key))
        indent += (indentSpec[key] || 0) * INDENTATION[key];
    }
    if (/^\s*\|/.test(textAfter))
      return (indent - 1) * indentUnit;
    else
      return indent * indentUnit;
  }


  var external = {
    startState: function(basecolumn) {
      return {
        tokenizer: tokenBase,
        lineState: new LineState([],
                                 new Indent(), new Indent(), 
                                 new Indent(), new Indent(),
                                 new Indent(), new Indent())
      };
    },

    copyState: copyState,
      
    token: function (stream, state) {
      console.log("In token for stream = ");
      console.log(stream);
      var sol = stream.sol();
      var style = state.tokenizer(stream, state);
      if (style === "IGNORED-SPACE")
        return null;
      parse(sol, state, stream, style);
      return style;
    },

    indent: indent,

    lineComment: "#",

    electricChars: "d||}]+-/=<>",
  };
  return external;
});

// CodeMirror.defineMIME("text/x-pyret", "pyret");

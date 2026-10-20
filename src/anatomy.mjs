// "File anatomy": a cheap, regex-only read of what is inside a file and what role it plays,
// so a building's shape can follow its structure. One pass over the lines, no parsing:
// the numbers are approximate on purpose (strings and comments can fool the brace counter).
//   c  classes / structs / interfaces / traits / enums
//   f  functions + methods          lf  longest function, in lines (rough)
//   x  exports (public surface)     r   role of the file in the repo

const KW = 'if|else|for|while|switch|return|do|case|catch|try|with|function|new|await|typeof|throw|sizeof|goto';
const MODS = 'public|private|protected|static|async|readonly|override|abstract|get|set|final|virtual|internal|synchronized|open|suspend|inline|export|default|declare';

const JS = {
  brace: true,
  cls: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum|namespace)\s+[\w$]/,
  // type-only declarations: used to tell "types" files from code; includes `type X = ...` and `declare`
  td: /^\s*(?:export\s+)?(?:declare\s+)?(?:(?:const\s+)?enum|interface|type)\s+[\w$]+\s*(?:<[^=]*>)?\s*(?:=|\{|extends)/,
  fn: new RegExp(
    '^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\b' +
    // const f = (a) => / x => / async (…) => / function(…)
    '|^\\s*(?:export\\s+)?(?:const|let|var)\\s+[\\w$]+\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)\\s*(?::\\s*[^=]+?)?\\s*=>|[\\w$]+\\s*=>|\\(\\s*$)' +
    // `app.use = function use(fn) {` / `exports.x = async function`
    "|^\\s*[\\w$.]+(?:\\[[^\\]]+\\])?\\s*=\\s*(?:async\\s+)?function\\b" +
    // class / object methods: `  async foo<T>(a, b): R {`
    `|^\\s+(?!(?:${KW})\\b)(?:(?:${MODS})\\s+)*\\*?#?[\\w$]+\\s*(?:<[^>]*>)?\\([^)]*\\)?\\s*(?::\\s*[^{;=]+)?\\{\\s*$`),
};

const LANG = {
  js: JS, ts: JS,
  py: {
    cls: /^\s*class\s+\w/,
    fn: /^\s*(?:async\s+)?def\s+\w/,
  },
  go: {
    brace: true,
    cls: /^type\s+\w+\s+(?:struct|interface)\b/,
    fn: /^func\s/,
    exp: /^func\s+(?:\([^)]*\)\s*)?[A-Z]|^type\s+[A-Z]|^(?:var|const)\s+[A-Z]/,
  },
  rs: {
    brace: true,
    cls: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+\w/,
    fn: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]*"\s+)?)?fn\s+\w/,
    exp: /^\s*pub\s+(?:(?:const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*(?:fn|struct|enum|trait|type|const|static|mod|use|union|macro)\b/,
  },
  java: {
    brace: true,
    cls: /^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record|@interface)\s+\w/,
    fn: /^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+(?:<[^>]+>\s+)?[\w<>\[\],.?]+\s+\w+\s*\([^;]*$/,
    exp: /^\s*public\s/,
  },
  kt: {
    brace: true,
    cls: /^\s*(?:(?:public|private|internal|data|sealed|open|abstract|enum|inner|annotation)\s+)*(?:class|interface|object)\s+\w/,
    fn: /^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|operator|abstract)\s+)*fun\s/,
    exp: /^\s*(?:(?:public|internal|data|sealed|open|abstract|enum|suspend|inline|override)\s+)*(?:class|interface|object|fun|val|var)\s/,
  },
  cs: {
    brace: true,
    cls: /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly)\s+)*(?:class|interface|enum|struct|record)\s+\w/,
    fn: /^\s+(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern)\s+)+(?:<[^>]+>\s+)?[\w<>\[\],.?]+\s+\w+\s*(?:<[^>]+>)?\s*\([^;]*$/,
    exp: /^\s*public\s/,
  },
  php: {
    brace: true,
    cls: /^\s*(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+\w/,
    fn: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s/,
    exp: /^\s*(?:public\s+(?:static\s+)?function|(?:abstract\s+|final\s+)?(?:class|interface|trait)\s)/,
  },
  swift: {
    brace: true,
    cls: /^\s*(?:(?:public|private|internal|open|final|fileprivate)\s+)*(?:class|struct|enum|protocol|actor)\s+\w/,
    fn: /^\s*(?:(?:public|private|internal|open|final|static|override|mutating|fileprivate)\s+)*func\s/,
    exp: /^\s*(?:public|open)\s/,
  },
  scala: {
    brace: true,
    cls: /^\s*(?:(?:case|sealed|abstract|final|private|protected)\s+)*(?:class|trait|object|enum)\s+\w/,
    fn: /^\s*(?:(?:override|private|protected|final|implicit)\s+)*def\s/,
    exp: /^\s*(?:(?:case|sealed|abstract|final)\s+)*(?:class|trait|object|def|val)\s/,
  },
  zig: {
    brace: true,
    cls: /^\s*(?:pub\s+)?const\s+\w+\s*=\s*(?:packed\s+|extern\s+)?(?:struct|enum|union)\b/,
    fn: /^\s*(?:pub\s+)?(?:export\s+)?(?:inline\s+)?fn\s/,
    exp: /^\s*pub\s/,
  },
  rb: {
    cls: /^\s*(?:class|module)\s+\w/,
    fn: /^\s*def\s/,
    exp: /^(?:class|module)\s+\w/,
  },
  ex: {
    cls: /^\s*defmodule\s/,
    fn: /^\s*defp?\s/,
    exp: /^\s*def\s/,
  },
  lua: { fn: /^\s*(?:local\s+)?function\s/ },
  sh: { fn: /^\s*(?:function\s+\w+|\w+\s*\(\s*\))\s*\{?\s*$/ },
};
// C and C++ share regexes: definitions start in column 0 with a return type
const C = {
  brace: true,
  cls: /^\s*(?:typedef\s+)?(?:enum\s+class|enum|class|struct|union)\s+\w*[^;()=]*$/,
  fn: /^(?!(?:if|else|for|while|switch|return|do|typedef|case|goto|extern|using|namespace)\b)[A-Za-z_][\w \t*&:<>,~]*[ \t*&]\**\w+(?:::~?\w+)*\s*\([^;]*$/,
  proto: /^(?!(?:typedef|static|return|else|using)\b)[A-Za-z_][\w \t*&:<>,~]*[ \t*&]\**\w+\s*\([^{]*\)[^{]*;\s*$/,
};
LANG.c = LANG.cpp = C;

const TEST_PATH = /(^|\/)(tests?|__tests\w*__|specs?|__mocks__|__fixtures__|fixtures?|e2e|cypress|testdata|playgrounds?)\/|\.(test|spec)\.\w+$|_test\.(go|py|rs|c|cc|cpp|exs?)$|(^|\/)test_[^/]*\.py$|(^|\/)conftest\.py$|[a-z0-9](Test|Tests|Spec)\.(java|kt|cs|swift|scala|php)$|(^|\/)tests?\.(rs|py|[cm]?[jt]s)$/;
const BUILD_PATH = /(^|\/)(scripts?|\.github|\.circleci|\.gitlab|ci)\/|(^|\/)(build\.rs|setup\.py|noxfile\.py|tasks\.py|fabfile\.py|Rakefile|gulpfile\.\w+|Gruntfile\.\w+|Makefile|Dockerfile[\w.-]*)$/;
const DOCS_PATH = /(^|\/)(docs?|documentation|examples?|samples?|demos?)\//i;
const CONFIG_PATH = /\.config\.[cm]?[jt]s$|(^|\/)\.?[\w-]+rc\.[cm]?js$|(^|\/)(settings|conf|config)\.py$/;
const TYPES_PATH = /\.d\.[cm]?ts$|(^|\/)(types?|typings?|_types)\.(?:[cm]?[jt]sx?|py)$|(^|\/)(types|typings)\/|(^|\/)_?typing\.py$/;
const INDEX_JS = /(^|\/)index\.[cm]?[jt]sx?$/;
const MANIFEST = /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|setup\.cfg|go\.mod|Gemfile|pom\.xml|build\.gradle(\.kts)?|requirements[^/]*\.txt)$/;
const REEX = /^export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]/gm;

const names = s => s.replace(/#.*/, '').split(',').filter(n => /\w/.test(n)).length;

export function fileAnatomy(p, text, lang) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (lang === 'cfg') {
    const r = MANIFEST.test(p) ? 'manifest' : /^tsconfig/.test(base) ? 'config' : 'build';
    return { c: 0, f: 0, lf: 0, x: 0, r };
  }
  let c = 0, f = 0, x = 0, lf = 0;
  let td = 0, kls = 0, code = 0, glue = 0; // glue: lines that only import / re-export / declare modules
  const L = LANG[lang];
  if (L && text) {
    const lines = text.split('\n');
    const py = lang === 'py', brace = L.brace;
    const init = py && p.endsWith('__init__.py');
    let imported = 0; // names a package __init__ pulls up to its namespace
    const isHdr = lang === 'c' && /\.h$/.test(p) || lang === 'cpp' && /\.(hpp|h)$/.test(p);
    const starts = []; // function start lines, for the gap heuristic
    const stack = []; // python: {s, ind}; braces: {s, d0}
    let pend = null, depth = 0, last = 0, blk = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trimStart();
      if (!t) continue;
      const ch = t.charCodeAt(0);
      // comment-ish lines: skip so a "{" or "def" in prose does not count
      if (ch === 47 && (t.charCodeAt(1) === 47 || t.charCodeAt(1) === 42)) continue; // // /*
      if (ch === 42 || (py && ch === 35)) continue; // * #
      code++;
      const ind = line.length - t.length;

      if (py) {
        while (stack.length && stack[stack.length - 1].ind >= ind) {
          const s = stack.pop();
          if (last - s.s + 1 > lf) lf = last - s.s + 1;
        }
        if (L.cls && L.cls.test(line)) { c++; if (ind === 0 && !/^class\s+_/.test(line)) x++; }
        if (L.fn.test(line)) {
          f++; stack.push({ s: i, ind });
          if (ind === 0 && !/^(?:async\s+)?def\s+_/.test(line)) x++;
        }
        // import-only lines (and their parenthesised continuations) mark package __init__ glue
        if (blk) { glue++; if (init) imported += names(line); if (/[)\]]/.test(line)) blk = false; }
        else if (/^(?:from\s+\S+\s+import|import\s)/.test(t) || /^__all__\s*[+]?=/.test(t)) {
          glue++;
          if (init && ch === 102) imported += names(line.slice(line.indexOf(' import') + 7));
          if (/[(\[]\s*(?:#.*)?$/.test(line)) blk = true;
        }
        last = i;
        continue;
      }

      if (L.cls && L.cls.test(line)) { c++; if (L.td && /\bclass\s/.test(line)) kls++; }
      if (L.td && L.td.test(line)) td++;
      if (L.fn.test(line)) {
        f++; starts.push(i);
        if (pend) f--; // previous header never got a body: TS overload / signature, not a function
        if (brace) pend = { s: i, d0: -1, par: 0 };
        if (L.exp && lang !== 'c' && lang !== 'cpp' && L.exp.test(line)) x++;
        if (lang === 'c' || lang === 'cpp') {
          if (!isHdr && !/^static\b/.test(line)) x++;
        }
      } else if (L.exp && lang !== 'js' && lang !== 'ts' && L.exp.test(line)) x++;
      else if (isHdr && C.proto.test(line)) x++;

      if (lang === 'rs') {
        // rust barrel files: `pub mod a;` / `pub use b::*;` / attributes, incl. multi-line use groups
        if (blk) { glue++; if (line.includes(';')) blk = false; }
        else if (/^(?:pub(?:\([^)]*\))?\s+)?(?:mod\s+\w+\s*;|use\s)/.test(t) || ch === 35) {
          glue++;
          if (t.startsWith('use') || t.startsWith('pub') ) if (line.includes('{') && !line.includes(';')) blk = true;
        }
      }

      if (brace && (line.includes('{') || line.includes('}') || pend)) {
        for (let k = 0; k < line.length; k++) {
          const cc = line.charCodeAt(k);
          if (cc === 123) { // {
            if (pend && pend.par <= 0) { stack.push({ s: pend.s, d0: depth }); pend = null; }
            depth++;
          } else if (cc === 125) { // }
            depth--;
            while (stack.length && depth <= stack[stack.length - 1].d0) {
              const s = stack.pop();
              if (i - s.s + 1 > lf) lf = i - s.s + 1;
            }
          } else if (pend) {
            if (cc === 40) pend.par++; else if (cc === 41) pend.par--;
          }
        }
        // bodyless: prototypes, trait signatures, expression-bodied arrows
        if (pend && pend.s === i && /;\s*$/.test(line)) { if (lf < 1) lf = 1; pend = null; }
        else if (pend && pend.s !== i && /;\s*$/.test(line)) { if (i - pend.s + 1 > lf) lf = i - pend.s + 1; pend = null; }
      }
    }
    // no closing brace to measure against (ruby, lua, elixir, shell): distance between starts
    if (!brace && !py) for (let k = 1; k < starts.length; k++) lf = Math.max(lf, starts[k] - starts[k - 1]);
    if (py) while (stack.length) { const s = stack.pop(); if (last - s.s + 1 > lf) lf = last - s.s + 1; }
    if (f && !lf) lf = 1;

    if (lang === 'js' || lang === 'ts') {
      // exports and re-exports need multi-line awareness, so use whole-text matches (cheap: guarded)
      let reex = 0, reLines = 0;
      if (text.includes('export')) {
        x += (text.match(/^export\s+(?!\{|\*|type\s*\{)(?:default|async|function|class|const|let|var|interface|type|enum|abstract|declare|namespace)\b/gm) || []).length;
        for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) x += m[1].split(',').filter(s => s.trim()).length;
        for (const m of text.matchAll(REEX)) { reex++; reLines += m[0].split('\n').length; }
        x += (text.match(/^export\s+\*/gm) || []).length;
      }
      if (text.includes('xports')) {
        x += (text.match(/^(?:module\.)?exports\.[\w$]+\s*=/gm) || []).length;
        const me = /^(?:(?:var|let|const)\s+[\w$]+\s*=\s*)?(?:exports\s*=\s*)?module\.exports\s*=\s*(\{[^}]*\})?/m.exec(text);
        if (me) x += me[1] ? Math.max(1, me[1].split(',').filter(s => s.trim()).length) : 1;
      }
      glue = reLines;
    }
    if (lang === 'py') {
      // an explicit __all__ is the real public surface; otherwise top-level public defs (counted above)
      const m = /^__all__\s*\+?=\s*[\[(]([^\])]*)[\])]/m.exec(text);
      if (m) x = (m[1].match(/['"][^'"]+['"]/g) || []).length;
      else if (init) x += imported;
    }
  }

  const a = { c, f, lf, x, r: 'source' };
  a.r = role(p, base, lang, a, td, code, glue, kls);
  return a;
}

function role(p, base, lang, a, td, code, glue, kls) {
  if (lang === 'css') return 'style';
  if (TEST_PATH.test(p)) return 'test';
  if (TYPES_PATH.test(p)) return 'types';
  if (BUILD_PATH.test(p)) return 'build';
  if (DOCS_PATH.test(p)) return 'docs';
  if (CONFIG_PATH.test(p)) return 'config';
  const ratio = code ? glue / code : 0;
  if (lang === 'py' && base === '__init__.py' && (ratio >= 0.5 || (!a.c && !a.f))) return 'index';
  if ((lang === 'js' || lang === 'ts') && glue) {
    // barrel: mostly `export … from`; index.* names need less proof than anonymous files
    if (INDEX_JS.test(p) ? ratio >= 0.4 || (a.f === 0 && ratio >= 0.2) : ratio >= 0.7) return 'index';
  }
  if (lang === 'rs' && /(^|\/)(mod|lib)\.rs$/.test(p) && ratio >= 0.5 && a.f <= 2) return 'index';
  // ts files that are mostly type/interface declarations rather than behaviour
  if (lang === 'ts' && td >= 2 && a.f < td / 2 && !kls) return 'types';
  return 'source';
}

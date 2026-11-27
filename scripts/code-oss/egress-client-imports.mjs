// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// How a shipped file may import the daemon's egress client (PV-N1d, web-rules.mjs rule 1b; review 1 S1). Only a static
// `import { ... } from "<client>"` naming the production factory (and the client's types) is allowed. Refused, wherever the
// specifier resolves to the client: a namespace import (`import * as e`, whose computed element access could reach the
// test factory), a default import, a side-effect import, `export ... from`, `import x = require()`, `import()`, `require()`,
// an `import("<client>").T` type, and any other name. So the test factory and its seam cannot be reached from src by
// any spelling, whichever file EGRESS_CLIENT_IMPORTERS lets import the client. Called by stage-ast.mjs scanModules, so the
// staged-tree check and the real-tree lint apply it alike.
import { posix } from "node:path";
import ts from "typescript6";
import { stagedPathOf } from "./egress-rules.mjs";
import { EGRESS_CLIENT_FILE } from "./web-rules.mjs";

/** The values an importer may take from the client. */
export const EGRESS_CLIENT_VALUES = new Set(["createEgressClient", "EGRESS_METHODS"]);
/** The types an importer may take from the client (a type-only import of anything else is refused too). */
export const EGRESS_CLIENT_TYPES = new Set(["EgressClient", "EgressClientOptions", "EgressClock", "EgressMethod", "EgressRequest", "EgressResponse"]);

const K = ts.SyntaxKind;
const isLiteral = (n) => n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

/**
 * True when `spec`, written in the staged file `fromRel`, names the egress client. The specifier is normalised first (review
 * 2 N1): a `?query` or `#fragment` suffix dropped, percent escapes decoded (a malformed one names the client, failing closed),
 * and any one script extension, `.d.ts` included, removed.
 */
export function namesEgressClient(fromRel, spec) {
  return resolvesTo(fromRel, spec, EGRESS_CLIENT_FILE);
}

/** The module that holds `takeAuthorization`, the credential's one reader (N1f nits review A). */
export const URL_PATTERN_FILE = "daemon-host/net/url-pattern.ts";
/** True when `spec`, written in `fromRel`, names url-pattern.ts (normalised as for the client). */
export function namesUrlPattern(fromRel, spec) {
  return resolvesTo(fromRel, spec, URL_PATTERN_FILE);
}

function resolvesTo(fromRel, spec, file) {
  if (typeof fromRel !== "string" || typeof spec !== "string" || !(spec.startsWith("./") || spec.startsWith("../"))) return false;
  let path = spec.replace(/[?#].*$/s, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return true;
  }
  const target = posix.normalize(posix.join(posix.dirname(fromRel), path));
  return target.replace(/\.d\.ts$|\.(?:js|mjs|cjs|ts|mts|cts|tsx|jsx)$/, "") === file.replace(/\.ts$/, "");
}

/**
 * How a shipped file other than the egress client may import url-pattern.ts: by static named imports, never
 * `takeAuthorization` (the credential's one reader, which only the egress client may hold), and never by a form that could
 * reach it by a computed name (a namespace, a default, a re-export, `import()`, `require()`, `import =`).
 */
function credentialReaderRefusals(sf, fromRel, at) {
  if (fromRel === EGRESS_CLIENT_FILE || fromRel === URL_PATTERN_FILE) return [];
  const bad = [];
  const hit = (n) => isLiteral(n) && namesUrlPattern(fromRel, n.text);
  const visit = (n) => {
    if (n.kind === K.ImportDeclaration && hit(n.moduleSpecifier)) {
      const clause = n.importClause;
      const named = clause?.namedBindings;
      if (clause !== undefined && clause.name !== undefined) bad.push(`${at(n)}: a default import of url-pattern (the credential reader's module)`);
      else if (named !== undefined && !ts.isNamedImports(named)) bad.push(`${at(n)}: a namespace import of url-pattern could reach the credential reader`);
      else if (named !== undefined) for (const e of named.elements) if ((e.propertyName ?? e.name).text === "takeAuthorization") bad.push(`${at(n)}: takeAuthorization is the credential reader: only the egress client may import it`);
    } else if (n.kind === K.ExportDeclaration && hit(n.moduleSpecifier)) bad.push(`${at(n)}: a re-export of url-pattern could hand out the credential reader`);
    else if (n.kind === K.ImportEqualsDeclaration && ts.isExternalModuleReference(n.moduleReference) && hit(n.moduleReference.expression)) bad.push(`${at(n)}: import = require() of url-pattern could reach the credential reader`);
    else if (n.kind === K.CallExpression && (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && hit(n.arguments[0])) {
      bad.push(`${at(n)}: a dynamic load of url-pattern could reach the credential reader`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

/** Every reason the parsed source `sf` imports the client other than by the allowed named imports (empty for the client itself). */
export function egressClientImportRefusals(sf, file, pkg, pkgRel, at) {
  const fromRel = stagedPathOf(file, pkg, pkgRel);
  if (fromRel === null) return [];
  const readerBad = credentialReaderRefusals(sf, fromRel, at);
  if (fromRel === EGRESS_CLIENT_FILE) return readerBad;
  const bad = [...readerBad];
  const hit = (n) => isLiteral(n) && namesEgressClient(fromRel, n.text);
  const visit = (n) => {
    if (n.kind === K.ImportDeclaration && hit(n.moduleSpecifier)) {
      const clause = n.importClause;
      const named = clause?.namedBindings;
      if (clause === undefined) bad.push(`${at(n)}: a side-effect import of the egress client`);
      else if (clause.name !== undefined) bad.push(`${at(n)}: a default import of the egress client`);
      else if (named === undefined || !ts.isNamedImports(named)) bad.push(`${at(n)}: a namespace import of the egress client (only named imports of the production factory)`);
      else {
        for (const e of named.elements) {
          const name = (e.propertyName ?? e.name).text;
          if (!EGRESS_CLIENT_VALUES.has(name) && !EGRESS_CLIENT_TYPES.has(name)) bad.push(`${at(n)}: ${name} is not something a file may take from the egress client`);
        }
      }
    } else if (n.kind === K.ExportDeclaration && hit(n.moduleSpecifier)) bad.push(`${at(n)}: a re-export of the egress client`);
    else if (n.kind === K.ImportEqualsDeclaration && ts.isExternalModuleReference(n.moduleReference) && hit(n.moduleReference.expression)) bad.push(`${at(n)}: import = require() of the egress client`);
    else if (n.kind === K.ImportType && ts.isLiteralTypeNode(n.argument) && hit(n.argument.literal)) bad.push(`${at(n)}: an import() type of the egress client`);
    else if (n.kind === K.CallExpression && (n.expression.kind === K.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require")) && hit(n.arguments[0])) {
      bad.push(`${at(n)}: a dynamic load of the egress client`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

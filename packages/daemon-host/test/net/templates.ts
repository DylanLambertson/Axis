// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { OperationTemplate } from "../../src/net/compose-request.js";

// Operation templates shared by the PV-N1e tests.

export const ISSUE: OperationTemplate = {
  method: "GET",
  path: [{ literal: "repos" }, { arg: "owner", type: { kind: "id" } }, { arg: "repo", type: { kind: "id" } }, { literal: "issues" }, { arg: "number", type: { kind: "int", min: 1 } }],
  query: [
    { key: "state", arg: "state", type: { kind: "enum", values: ["open", "closed"] }, required: false },
    { key: "per_page", arg: "perPage", type: { kind: "int", min: 1, max: 100 }, required: false },
    { key: "q", arg: "search", type: { kind: "text" }, required: false },
  ],
};
export const NAMED: OperationTemplate = { method: "GET", path: [{ literal: "labels" }, { arg: "name", type: { kind: "text" } }] };

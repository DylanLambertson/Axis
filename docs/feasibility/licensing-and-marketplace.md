# Axis: Licensing, Trademark and Extension-Marketplace Constraints (Code OSS 1.144.0)

Upstream: `microsoft/vscode` tag `1.144.0`, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` (tag ref verified via GitHub API; commit date 2026-10-27T20:18Z) [S1]. Research date: 2026-11-01.

Labels: **VERIFIED** = read in the primary source; **INFERRED** = reasoned from sources; **UNKNOWN** = could not be verified.
This is an engineering constraints summary, not legal advice. Items marked **LEGAL REVIEW** need counsel sign-off before release.

## Summary (decisions / constraints for Axis)

1. **Keep the upstream MIT notice and third-party notices in every artifact.** That means `LICENSE.txt` (Microsoft copyright plus the permission notice) and `ThirdPartyNotices.txt` (plus `cli/ThirdPartyNotices.txt` if the Rust CLI ships), in the desktop, server and web builds. The desktop gulp task already packages them. The server/web (`reh`) tasks only copy `remote/LICENSE`, which does not exist at this tag, so Axis has to add notices there itself. Axis's own code may carry a different (including commercial) license. [S2][S3][S4] VERIFIED / INFERRED
2. **Rebrand fully.** Replace every identity key in `product.json` (names, app IDs, bundle IDs, mutexes, URL protocol, data folders, win32 strings containing "Microsoft"). Replace every icon and image in `resources/`. Never use "Visual Studio Code", "VS Code" or the VS Code icon in the product name, domain, app icon or marketing. Add a "not affiliated with Microsoft" statement, as OpenVSCode Server does. [S6][S7][S9][S10][S36] VERIFIED
3. **Do not connect to the Visual Studio Marketplace.** Its Terms of Use (Last Updated September 2025) restrict Marketplace Offerings to "In-Scope Products and Services" (Visual Studio, VS Code, Codespaces, Azure DevOps and successors). Configure `product.json` `extensionsGallery` to Open VSX or a self-hosted Eclipse Open VSX, as VSCodium, OpenVSCode Server, code-server and Positron do. [S12][S19][S35][S36][S37] VERIFIED
4. **Plan Open VSX capacity and governance before launch.** The public `open-vsx.org` registry is free and provided "AS IS" with no availability assurance. Eclipse began rate limiting "sustained, high-volume automated traffic" in 2026 and offers a paid "Open VSX Managed Registry" aimed at "commercial software products where extensions are part of the core experience". A commercial Axis should either contract for that or run or mirror its own registry. [S13][S16][S17][S18] VERIFIED; **LEGAL REVIEW / business decision**
5. **Do not offer or bundle Microsoft-proprietary extensions.** That covers Pylance, the C/C++ binaries, C# Dev Kit, Remote-SSH/Containers/WSL, Live Share and the Marketplace build of Copilot Chat. Their licenses limit use to Microsoft products, and none of them is on Open VSX. Ship or recommend open alternatives instead (basedpyright/pyright, clangd, Open Remote - SSH/WSL). The Python, Jupyter, debugpy, ESLint and Prettier extensions are MIT-licensed and are on Open VSX. [S21][S24]–[S32] VERIFIED
6. **New at this tag: GitHub Copilot is wired into core, and this is the highest-risk item.**
   - The root `package.json` depends on `@vscode/copilot-api`. Its license allows use "only with the Visual Studio Code or Code-OSS ... The use with Code-OSS is allowed for development purposes only."
   - The root `package.json` also depends on `@github/copilot-sdk`, and the build bundles its platform runtime packages.
   - `extensions/copilot` (MIT source) depends on `@github/copilot`, which is under the GitHub Copilot CLI License.
   - `product.json` sets `defaultChatAgent` to GitHub Copilot.
   - Axis must remove or replace these before distribution, or get explicit legal clearance. [S7][S31] VERIFIED; **LEGAL REVIEW**
7. **Telemetry is off in a clean Code OSS build. Keep it that way, or use Axis-owned infrastructure.** The OSS `product.json` has no `enableTelemetry` or `aiConfig.ariaKey`, so built OSS builds report `supportsTelemetry() === false`. Strip or replace the remaining Microsoft and GitHub online endpoints in `product.json`: `voiceWsUrl`, `webviewContentExternalBaseUrlTemplate` (vscode-cdn.net) and the `defaultChatAgent` URLs. [S7][S33] VERIFIED / INFERRED
8. **Do not use Microsoft's private `product.json` values.** That includes telemetry keys, update URLs, experiment and survey URLs, and the gallery. The repo wiki says Microsoft keeps them private "so that other distributions cannot send us telemetry". [S6] VERIFIED

---

## 1. Code OSS license and redistribution obligations

| Finding | Status | Source |
|---|---|---|
| `LICENSE.txt` at the tag is the standard MIT License: "Copyright (c) 2015 - present Microsoft Corporation". The condition is: "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software." | VERIFIED | [S2] |
| The README says "This source code is available to everyone under the standard MIT license", and that "Visual Studio Code is a distribution of the `Code - OSS` repository with Microsoft-specific customizations released under a traditional Microsoft product license." | VERIFIED | [S5] |
| The Microsoft "Visual Studio Code" product license (MICROSOFT SOFTWARE LICENSE TERMS – MICROSOFT VISUAL STUDIO CODE) "applies to the Visual Studio Code product". It prohibits removing Microsoft notices and "share, publish, rent or lease the software". It states "Source code for Visual Studio Code is available at https://github.com/Microsoft/vscode under the MIT license agreement." Axis builds from source, so this product license does not govern Axis. Axis must not redistribute Microsoft's binaries. | VERIFIED (quotes) / INFERRED (applicability) | [S11] |
| `ThirdPartyNotices.txt` (≈180 KB) opens with "This repository incorporates material as listed below or described in the code." It lists components with their license texts (≈74 headed entries, e.g. `@fig/autocomplete-shared`, the `atom/language-*` grammars). Separate notices exist for `cli/` (Rust CLI), `build/monaco/`, `extensions/mermaid-markdown-features`, `extensions/terminal-suggest` and `extensions/theme-seti`. | VERIFIED | [S3] |
| `cgmanifest.json` (root has 14 registrations, e.g. Chromium under BSD, which requires reproducing its notice in binary distributions). There are 77 `cgmanifest.json` files across the tree. They are Component Governance inputs from which the notices are generated. `cglicenses.json` says it "overrides licenses only for OSS components which do not appear in `cgmanifest.json`". Its comments refer to a `scan-licenses.ts` tool and a "Linux NOTICE agent", which suggests regeneration runs in Microsoft's pipeline. | VERIFIED (contents) / INFERRED (pipeline) | [S3] |
| The desktop build packages `[product.licenseFileName, 'ThirdPartyNotices.txt', 'licenses/**']` (`build/gulpfile.vscode.ts` L234). The server (`gulpfile.reh.ts` L351) and web (`gulpfile.vscode.web.ts` L49) builds only copy `remote/LICENSE` with `allowEmpty: true`, and `remote/LICENSE` is absent from the tree at this tag. | VERIFIED | [S4] |
| **Derivative must preserve:** the Microsoft MIT copyright and permission notice; the third-party notices for every bundled component, including the Electron/Chromium/Node notices and the notices of built-in extensions; and per-file headers ("Licensed under the MIT License"). Axis should regenerate notices whenever dependencies change, because it cannot rely on Microsoft's CG pipeline. | INFERRED | [S2][S3][S4] |
| Axis's own additions can be under any license, including proprietary. Positron (Elastic License 2.0) is a precedent: it ships the upstream-derived `ThirdPartyNotices.txt`. **LEGAL REVIEW:** the license text and placement for Axis's own code. | INFERRED | [S37] |

## 2. Trademark and branding

**Microsoft guidance (VERIFIED):**
- VS Code brand page [S9], under "Not OK":
  - "Using the product name — Visual Studio Code or VS Code — on your website, product, service, or in your domain names."
  - "Naming your products, applications, or projects anything that implies an endorsement from Microsoft or the Visual Studio Code team."
  - "Creating a modified version of the icon".
  - Integrating the icon into your own logo.
  - The page also states: "Visual Studio Code, VS Code, and the Visual Studio Code icon are trademarks of Microsoft Corporation."
- Microsoft Trademark and Brand Guidelines [S10]:
  - "Don't use Microsoft's Brand Assets in the name of your business, product, service, app, domain name".
  - "Microsoft's logos, designs, and icons can never be used as your app icon".
  - "Don't imply an affiliation, endorsement, sponsorship, or approval with or by Microsoft."
- Repo wiki, "Differences between the repository and Visual Studio Code" [S6]: "Icons, Product Name (e.g. 'Microsoft Visual Studio Code'), Documentation" are Microsoft trademarks. "Static assets such as icons and the desktop image are included in the distro. Product names and documentation URLs are added to `product.json`." This means the OSS repo ships non-Microsoft-product assets, and the VS Code brand assets are added only in Microsoft's distribution.

**`product.json` keys at 1.144.0 to change (VERIFIED present [S7]; interface in `src/vs/base/common/product.ts` [S8]):**

| Category | Keys (current OSS value) |
|---|---|
| Identity / naming | `nameShort`, `nameLong` ("Code - OSS"), `applicationName` ("code-oss"), `dataFolderName` (".vscode-oss"), `sharedDataFolderName`, `serverApplicationName` ("code-server-oss"), `serverDataFolderName`, `tunnelApplicationName`, `urlProtocol` ("code-oss"), `linuxIconName`, `agentsTelemetryAppName` |
| Platform IDs containing Microsoft/visualstudio strings | `win32DirName`/`win32NameVersion` ("Microsoft Code OSS"), `win32AppUserModelId` ("Microsoft.CodeOSS"), `win32RegValueName`, `win32MutexName`, `win32ShellNameShort`, `win32TunnelServiceMutex`, `win32TunnelMutex`, `win32x64AppId`/`win32arm64AppId`/`win32x64UserAppId`/`win32arm64UserAppId` (GUIDs; must be new so installers do not collide), `darwinBundleIdentifier` ("com.visualstudio.code.oss"), `darwinProfileUUID`, `darwinProfilePayloadUUID`, `linuxDesktopName` ("com.visualstudio.CodeOSS") |
| License / links | `licenseName`, `licenseUrl`, `serverLicenseUrl` (point to microsoft/vscode), `licenseFileName`, `serverLicense`, `serverLicensePrompt`, `serverGreeting`, `reportIssueUrl` (microsoft/vscode issues) |
| Microsoft/GitHub service endpoints | `webviewContentExternalBaseUrlTemplate` (`https://{{uuid}}.vscode-cdn.net/...`), `voiceWsUrl` (`wss://falcon-caas.mai.microsoft.com/...`), `defaultChatAgent` (GitHub Copilot extension IDs plus `api.github.com/copilot_internal/...` URLs), `trustedExtensionAuthAccess` (GitHub.copilot-chat), `builtInExtensionsEnabledWithAutoUpdates` (["GitHub.copilot-chat"]) |
| Marketplace-adjacent | `builtInExtensions` (3 ms-vscode MIT extensions fetched from GitHub releases when no gallery is set [S39]), `onboardingKeymaps` (label "VS Code"; extension IDs resolved from the gallery) |
| Absent in OSS, set by Microsoft's distro (do not copy Microsoft values) | `extensionsGallery`, `mcpGallery`, `updateUrl`, `downloadUrl`, `enableTelemetry`, `aiConfig.ariaKey`, `tasConfig`, `crashReporter`, `appCenter`, `surveys`, `settingsSearchUrl`, `extensionRecommendations`/`*ExtensionTips`, `extensionEnabledApiProposals`, `configurationSync.store`, `editSessions.store`, `linkProtectionTrustedDomains`, `msftInternalDomains`, `releaseNotesUrl`, `documentationUrl` [S6][S8] |

**Resources to replace (VERIFIED in the tree [S1]):**
- `resources/darwin/*.icns` (including `code.icns` and file-type icons)
- `resources/win32/*.ico`, `code_70x70.png`, `code_150x150.png` and the `inno-*.bmp` installer images
- `resources/linux/code.png` and `rpm/code.xpm`
- `resources/server/code-192.png`, `code-512.png`, `favicon.ico` and `resources/server/manifest.json` names

VSCodium replaces the full `src/stable/resources/` tree and rewrites the server manifest names [S19]. Whether the OSS icons themselves are Microsoft trademarks: UNKNOWN. Replacing them is the safe engineering default. **LEGAL REVIEW:** the "Axis" mark clearance, and descriptive uses such as "compatible with VS Code extensions".

## 3. Extension marketplace

**Visual Studio Marketplace Terms of Use** (PDF, "Last Updated September 2025", linked via `aka.ms/vsmarketplace-ToU`) [S12], VERIFIED quotes:
- §1: the Marketplace offers products "designed to work with and extend the capabilities of Microsoft Visual Studio, Visual Studio Code, GitHub Codespaces, Azure DevOps, Azure DevOps Server, and successor products and services (the 'In-Scope Products and Services')".
- §2(b): "Marketplace Offerings are intended for use only with In-Scope Products and Services and you may not install, reverse-engineer, import or use Marketplace Offerings in products and services except for the In-Scope Products and Services."
- §3: access is only "directly from Microsoft's publicly supported interfaces". Scraping and "spidering" are prohibited. Also: "You may not import, install, or use Offerings published by Microsoft or GitHub, or Microsoft affiliates in any products or services except for the In-Scope Products and Services."
- Wiki [S6]: "The Marketplace is not a general purpose store designed to support any distribution or a subset of distributions."
- **Constraint:** Axis is not an In-Scope Product. It must not point `extensionsGallery` at the Marketplace, proxy or mirror Marketplace VSIXs, or tell users to side-load Microsoft-published VSIXs. INFERRED from the clauses above. **LEGAL REVIEW** for any user-initiated VSIX install guidance.

**Open VSX** (VERIFIED unless noted):
- **Operator and governance:** "The Open VSX Registry is managed by the Eclipse Foundation's Open VSX Working Group" and is built on the open-source Eclipse Open VSX project [S15]. The website Terms of Use (dated February 11, 2021) make the service one "provided by the Eclipse Foundation AISBL" [S13].
- **Consumer terms** [S13]:
  - Content comes from "Third Party Publishers, under terms and licenses (including proprietary licenses)", and complying with them is the user's responsibility.
  - Neither the Foundation nor its Members "assume any responsibility regarding the Content nor the availability of such Content".
  - All content is "AS IS". Liability is capped at "FIVE EUROS".
  - The Foundation may "block access from a particular Internet address".
  - There is no clause limiting which IDEs or clients may consume the registry.
- **Fees** [S15]: "All extensions in the Open VSX Registry are made available without fee, subject to the terms of the respective licenses."
- **Publisher terms:** publishers must accept the Open VSX Publisher Agreement (v1.1, September 2025) [S14][S15]. Every extension must declare a license, which does not have to be open source [S15].
- **Availability / rate limits:**
  - Eclipse blog, 2026-02-11 [S16]: a tiered rate-limiting rollout aimed at high-volume automated traffic, starting with a monitoring period. Organisations with "sustained or commercial-scale use" are asked to contact `infrastructure@eclipse-foundation.org`.
  - Eclipse press release, 2026-03-03 [S17]: ">300 million downloads per month", "Rate limiting is targeted at sustained, high-volume automated traffic", and the registry is "self-hostable".
  - `managed.open-vsx.org` [S18] describes a paid "Open VSX Managed Registry" for "Commercial software products where extensions are part of the core experience" and lists AWS, Cursor, Google, IBM and Windsurf as adopters. Pricing and SLA terms are UNKNOWN (not published on the page).
- **Configuring Code OSS for Open VSX:**
  - VSCodium's `prepare_vscode.sh` (commit `ca7f7b4`, 2026-10-27) sets `"extensionsGallery": {"serviceUrl": "https://open-vsx.org/vscode/gallery", "itemUrl": "https://open-vsx.org/vscode/item", "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest", "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"}`. It also sets `linkProtectionTrustedDomains: ["https://open-vsx.org"]` [S19].
  - OpenVSCode Server adds `resourceUrlTemplate: https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}` and `extensionUrlTemplate` [S36].
  - At 1.144.0 the typed fields are `serviceUrl`, `controlUrl`, `extensionUrlTemplate`, `resourceUrlTemplate`, `nlsBaseUrl`, `accessSKUs` and `accessScopes` [S8]. The manifest service also reads `itemUrl` and `publisherUrl` [S40]. VERIFIED
  - A user/enterprise setting `extensions.gallery.serviceUrl` ("Private marketplace") can override the gallery at runtime [S40]. VERIFIED
  - When `extensionsGallery` is set, the build fetches `builtInExtensions` from it rather than from GitHub releases [S39]. VERIFIED. Axis should pin the built-ins with sha256, as the OSS `product.json` already does.
- **Alternatives:** self-host Eclipse Open VSX (VSCodium docs describe self-hosting [S20]), or use a mirror (Positron uses `p3m.dev/openvsx` [S37]). INFERRED as options; the choice is a **business decision**.

## 4. Microsoft-proprietary and other key extensions

The Open VSX presence column comes from the API `GET https://open-vsx.org/api/{namespace}/{name}` on 2026-11-01 [S24].

| Extension | License (as published) | On Open VSX? | Restriction / evidence | Status |
|---|---|---|---|---|
| Pylance `ms-python.vscode-pylance` | Microsoft Software License Terms (Marketplace license page) | No ("Extension not found") | "install and use ... only with Microsoft Visual Studio, Visual Studio for Mac, Visual Studio Code, Azure DevOps, Team Foundation Server, and successor Microsoft products and services" [S26]. A Microsoft responder points Open VSX users to the Pyright extension instead [S41]. Runtime host check: UNKNOWN | VERIFIED (license, absence) |
| C/C++ `ms-vscode.cpptools` | Repo source MIT, but "Additional binary files are included in the official VSIX ... governed by the more restrictive proprietary license terms" (RuntimeLicenses) | No | `cpptools-LICENSE.txt` §1(a): "only with Microsoft Visual Studio, Visual Studio for Mac, Visual Studio Code, Azure DevOps, Team Foundation Server, and successor Microsoft products" [S25]. VSCodium lists it as incompatible [S21] | VERIFIED |
| C# Dev Kit `ms-dotnettools.csdevkit` | Proprietary (`aka.ms/vs/csdevkit/license` resolves to the Marketplace license page) | No | "You may install and use the Software only with Microsoft Visual Studio Code, vscode.dev, GitHub Codespaces ... (the 'In-Scope Products and Services')" [S27]. Maintainer, 2023-11-30: "the current license terms for this particular extension do not allow for use in the other derivatives" [S27]. Note `ms-dotnettools.csharp` is also absent from Open VSX [S24]. Wiki: the C#/.NET debugger uses a "handshake" to check it runs in VS Code [S6] | VERIFIED |
| Remote-SSH / Dev Containers / WSL `ms-vscode-remote.*` | MICROSOFT PRE-RELEASE SOFTWARE LICENSE TERMS (`LICENSE-extensions`) | No (all three) | "You may use a copy of the software with each validly licensed copy of Microsoft Visual Studio Code. You may not use the software if you do not have a license for Microsoft Visual Studio Code." Also prohibits "provide the software as a stand-alone or integrated offering" [S28]. Wiki: "Parts of the code to negotiate a connection to the Visual Studio Code server are proprietary" [S6] | VERIFIED |
| Live Share `ms-vsliveshare.vsliveshare` | Microsoft Software License Terms | No | "install and use any number of copies of the software to use solely with Microsoft Visual Studio family of products" [S29] | VERIFIED |
| GitHub Copilot Chat `GitHub.copilot-chat` | Source in `microsoft/vscode/extensions/copilot` is MIT (`LICENSE.txt`, `package.json` license "SEE LICENSE IN LICENSE.txt", v0.72.0). The Marketplace VSIX is under "GITHUB LICENSE TERMS FOR EXTENSIONS" | No | Marketplace license: "install and use ... only with GitHub approved software". Use of GitHub Services needs a "separate agreement(s)" [S30]. The README requires "an active GitHub Copilot subscription" [S30]. The old `microsoft/vscode-copilot-chat` repo is archived and moved into core [S30] | VERIFIED |
| GitHub Copilot `GitHub.copilot` (inline suggestions) | UNKNOWN: the Marketplace page does not show a license name | No | Presumably the same GitHub extension terms as Copilot Chat. UNKNOWN | UNKNOWN |
| Core Copilot dependencies at this tag | `@vscode/copilot-api` 0.5.2: GitHub "npm Module Terms and Conditions"; `@github/copilot-sdk`: MIT (`cglicenses.json` override; platform packages MIT; the license was read on registry version 1.0.28, while root `package.json` pins `1.0.27-unstable.40031404408.gba6c003`, so confirm on the pinned version); `@github/copilot` 1.0.105: "GitHub Copilot CLI License" | n/a | `@vscode/copilot-api`: "only with the Visual Studio Code or Code-OSS ... The use with Code-OSS is allowed for development purposes only. No other use is permitted." The Copilot CLI License permits redistribution only of "unmodified copies" as part of an app providing "material functionality beyond the Software" and with the license included. Root `package.json` lists `@github/copilot-sdk` and `@vscode/copilot-api` under `dependencies`. `extensions/copilot/package.json` lists `@github/copilot` [S31] | VERIFIED; **LEGAL REVIEW** |
| Jupyter `ms-toolsai.jupyter` | MIT (repo and Open VSX metadata) | Yes, v2025.9.1 (2025-10-14, verified namespace) | Version on Open VSX may lag the Marketplace. Whether it depends on proprietary companions (e.g. Pylance for IntelliSense): UNKNOWN | VERIFIED (license, presence) |
| Python `ms-python.python` (+ `ms-python.debugpy`) | MIT | Yes, v2026.4.0 (2026-03-13); debugpy v2026.6.0 | VSCodium lists "Python" as incompatible [S21], probably due to Pylance/companion dependencies. Exact behaviour in Axis: UNKNOWN; test it | VERIFIED (license, presence) / UNKNOWN (behaviour) |
| ESLint `dbaeumer.vscode-eslint` | MIT | Yes, v3.0.34 (2026-07-17) | None found | VERIFIED |
| Prettier `esbenp.prettier-vscode` | MIT | Yes, v12.4.0 (2026-03-16) | None found | VERIFIED |

Open replacements documented by VSCodium [S21]: clangd and Native Debug (C/C++), BasedPyright (Python), and Open Remote - SSH / Open Remote - WSL (`jeanp413.*`). Each needs its own license check before Axis bundles it (UNKNOWN).

## 5. Telemetry

| Finding | Status | Source |
|---|---|---|
| The OSS `product.json` has no `enableTelemetry`, `aiConfig`, `tasConfig`, `crashReporter`, `appCenter` or `surveys` keys. | VERIFIED | [S7] |
| `supportsTelemetry()`: when running out of sources (not built) and not disabled, telemetry is allowed "for logging only purposes". Otherwise it returns `!(environmentService.disableTelemetry \|\| !productService.enableTelemetry)`, so a built OSS product without `enableTelemetry` reports false. | VERIFIED | [S33] |
| `1dsAppender.ts` hard-codes `https://mobile.events.data.microsoft.com/OneCollector/1.0`. Sending requires an instrumentation key from `aiConfig.ariaKey`, which OSS lacks. | VERIFIED (URL) / INFERRED (gating) | [S33] |
| The Microsoft distribution adds "App Insights telemetry keys, Hockey App URLs, Experiment URLs, and Survey probabilities and URLs ... in `product.json` and are private so that other distributions cannot send us telemetry". | VERIFIED | [S6] |
| VS Code telemetry types: crash reports, error telemetry and usage data, controlled by `telemetry.telemetryLevel` (`all`/`error`/`crash`/`off`). "These extensions may be collecting their own usage data and are not controlled by the telemetry.telemetryLevel". | VERIFIED | [S34] |
| VSCodium does not set the telemetry build flags. It rewrites `//*.data.microsoft.com` to `//0.0.0.0` across the source (`undo_telemetry.sh`). It defaults `telemetry.telemetryLevel`, `telemetry.enableCrashReporter`, `workbench.enableExperiments` and natural-language settings search to off, and recommends reviewing settings tagged `@tag:usesOnlineServices`. | VERIFIED | [S22] |
| **Axis constraints:** never set Microsoft keys. Either leave `enableTelemetry` unset/false, or implement Axis-owned, opt-in telemetry with its own appender and endpoint (a `customEndpointTelemetryService` exists in `src/vs/platform/telemetry/{node,electron-browser}`). Neutralise or replace the other Microsoft/GitHub endpoints (`voiceWsUrl`, `webviewContentExternalBaseUrlTemplate`, `defaultChatAgent` URLs). Audit bundled extensions (notably `extensions/copilot`) for their own telemetry, which is UNKNOWN (not read). **LEGAL REVIEW:** the privacy notice/GDPR stance for any Axis telemetry. | INFERRED | [S6][S7][S22][S33][S34] |

## 6. Precedents

- **VSCodium** (MIT). Overrides `product.json` at build time: names, `licenseUrl` set to VSCodium's LICENSE, `reportIssueUrl`, and `extensionsGallery` set to Open VSX. Copies its own icons from `src/stable/resources`. Strips Microsoft telemetry hosts. Its docs explain that Microsoft "prohibits usages of the Microsoft marketplace by any other products" and list Microsoft extensions incompatible "by their license and by running additional checks in their proprietary code". [S19][S20][S21][S22][S23] VERIFIED
- **Eclipse Theia** (EPL-2.0, secondary GPL-2.0 with Classpath Exception). Not a fork. It keeps `LICENSE-vscode.txt` with the full VS Code MIT text for adopted code. Its `@theia/vsx-registry` defaults to `https://open-vsx.org`, overridable with `VSX_REGISTRY_URL`. [S38] VERIFIED
- **Gitpod OpenVSCode Server** (MIT). Brands `nameLong` as "OpenVSCode Server", points `licenseUrl` at its own LICENSE and `extensionsGallery` at Open VSX. Its README states "This project is not affiliated with Microsoft Corporation." Repository last pushed 2026-09-24; the latest `main` commit and release are from 2026-02-20 (see `integration-alternatives.md` §D). [S36] VERIFIED
- **Positron** (posit-dev). Proprietary product license (Elastic License 2.0 plus an education exception). Ships the upstream-derived `ThirdPartyNotices.txt` and `cglicenses.json`. Its gallery points to a Posit-hosted Open VSX mirror (`https://p3m.dev/openvsx/latest/vscode/gallery`). A text search did not locate the upstream Microsoft MIT copyright line in its root license files, so where it is preserved is UNKNOWN. [S37] VERIFIED / UNKNOWN
- **VSCodium Copilot removal** (most direct precedent for summary item 6). VSCodium `master` carries `patches/52-ext-copilot-remove-it.json` (a removal manifest of about 125 paths) and `patches/53-ext-copilot-remove-it.patch` (29 files, about 3,567 changed lines, about 1,470 of them lockfile changes). At 1.144.0, `@vscode/copilot-api` is imported by 4 non-test core files under `src/vs/platform/agentHost/` plus `src/typings/copilot-api.d.ts`; `@github/copilot-sdk` is imported by 54 non-test files under `src/vs/platform/agentHost/**`; and `build/lib/copilot.ts:56-60` throws if the SDK metadata is missing. Removal is therefore a substantial patch, not just deleting `extensions/copilot`. See ADR 0002 for how it is budgeted. VERIFIED (independent review of 2026-11-01 against VSCodium `master` and the 1.144.0 tree)
- **code-server** (Coder, MIT). Its FAQ quotes the Marketplace ToU as the reason it "can't offer any extensions on Microsoft's marketplace". It uses Open VSX, lists Live Share and the Remote extensions as unavailable closed-source extensions, and allows a custom gallery via `$EXTENSIONS_GALLERY`. [S35] VERIFIED

## Open items for legal review

1. Distribution of, or removal plan for, `@vscode/copilot-api`, `@github/copilot-sdk` (and its bundled runtime) and `@github/copilot`. Whether Axis may build and ship the MIT `extensions/copilot` source at all, given that it needs GitHub services under separate terms.
2. Open VSX commercial-scale usage: managed registry contract vs. self-hosting. The licenses of extensions mirrored or bundled.
3. Trademark clearance for "Axis", and the wording of any "compatible with VS Code extensions" claim.
4. Third-party notice completeness for server/web builds and for the Electron/Chromium binaries.
5. Privacy terms if Axis adds telemetry.

## Sources (all accessed 2026-11-01)

- [S1] Tag and tree: `https://api.github.com/repos/microsoft/vscode/git/ref/tags/1.144.0`; `.../git/trees/2c33b50b16c472efe58357d1d2a8a5414bc23fbf?recursive=1`
- [S2] `https://api.github.com/repos/microsoft/vscode/contents/LICENSE.txt?ref=1.144.0`
- [S3] `.../contents/ThirdPartyNotices.txt?ref=1.144.0`; `.../contents/cgmanifest.json?ref=1.144.0`; `.../contents/cglicenses.json?ref=1.144.0`
- [S4] `.../contents/build/gulpfile.vscode.ts?ref=1.144.0`; `.../build/gulpfile.reh.ts?ref=1.144.0`; `.../build/gulpfile.vscode.web.ts?ref=1.144.0`
- [S5] `.../contents/README.md?ref=1.144.0`
- [S6] https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code (raw: `https://raw.githubusercontent.com/wiki/microsoft/vscode/Differences-between-the-repository-and-Visual-Studio-Code.md`)
- [S7] `.../contents/product.json?ref=1.144.0`
- [S8] `.../contents/src/vs/base/common/product.ts?ref=1.144.0`; `.../src/vs/platform/product/common/product.ts?ref=1.144.0`
- [S9] https://code.visualstudio.com/brand
- [S10] https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks
- [S11] https://code.visualstudio.com/license
- [S12] https://aka.ms/vsmarketplace-ToU → https://cdn.vsassets.io/v/M264_20251020.18/_content/Microsoft-Visual-Studio-Marketplace-Terms-of-Use.pdf ("Last Updated September 2025")
- [S13] https://open-vsx.org/terms-of-use (content: https://open-vsx.org/documents/terms-of-use.md)
- [S14] https://open-vsx.org/documents/publisher-agreement-v1.1.md
- [S15] https://www.eclipse.org/legal/open-vsx-registry-faq/
- [S16] https://blogs.eclipse.org/node/8762 ("Scaling the Open VSX Registry responsibly with rate limiting", 2026-02-11)
- [S17] https://newsroom.eclipse.org/node/43620 (2026-03-03)
- [S18] https://managed.open-vsx.org/
- [S19] https://github.com/VSCodium/vscodium/blob/ca7f7b44b5e5c3faa663f6cdc043998f71936653/prepare_vscode.sh; `product.json`; `src/stable/resources/`
- [S20] https://github.com/VSCodium/vscodium/blob/master/docs/extensions.md
- [S21] https://github.com/VSCodium/vscodium/blob/master/docs/extensions-compatibility.md
- [S22] https://github.com/VSCodium/vscodium/blob/master/docs/telemetry.md; `undo_telemetry.sh`
- [S23] https://github.com/VSCodium/vscodium/blob/master/README.md
- [S24] Open VSX API: `https://open-vsx.org/api/{namespace}/{name}` for each extension ID in §4
- [S25] https://github.com/microsoft/vscode-cpptools/blob/main/LICENSE.md; `RuntimeLicenses/cpptools-LICENSE.txt`, `vsdbg-LICENSE.txt`
- [S26] https://marketplace.visualstudio.com/items/ms-python.vscode-pylance/license
- [S27] https://aka.ms/vs/csdevkit/license → https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license; https://github.com/microsoft/vscode-dotnettools/issues/765
- [S28] https://github.com/microsoft/vscode-remote-release/blob/main/LICENSE-extensions
- [S29] https://marketplace.visualstudio.com/items/ms-vsliveshare.vsliveshare/license
- [S30] https://marketplace.visualstudio.com/items/GitHub.copilot-chat/license; `.../contents/extensions/copilot/LICENSE.txt?ref=1.144.0`; `.../extensions/copilot/package.json?ref=1.144.0`; https://github.com/microsoft/vscode-copilot-chat (archived README); https://marketplace.visualstudio.com/items?itemName=GitHub.copilot
- [S31] `.../contents/package.json?ref=1.144.0`; `.../build/lib/copilot.ts?ref=1.144.0`; https://registry.npmjs.org/@vscode/copilot-api/-/copilot-api-0.5.2.tgz (LICENSE); https://registry.npmjs.org/@github/copilot/-/copilot-1.0.105.tgz (LICENSE.md); https://registry.npmjs.org/@github/copilot-sdk/1.0.28
- [S32] GitHub repo license metadata: microsoft/vscode-jupyter, microsoft/vscode-python, microsoft/vscode-eslint, prettier/prettier-vscode
- [S33] `.../src/vs/platform/telemetry/common/telemetryUtils.ts?ref=1.144.0`; `.../src/vs/platform/telemetry/common/1dsAppender.ts?ref=1.144.0`
- [S34] https://code.visualstudio.com/docs/configure/telemetry
- [S35] https://github.com/coder/code-server/blob/main/docs/FAQ.md
- [S36] https://github.com/gitpod-io/openvscode-server (README, product.json)
- [S37] https://github.com/posit-dev/positron (LICENSE.txt, product.json, ThirdPartyNotices.txt)
- [S38] https://github.com/eclipse-theia/theia (README, LICENSE-vscode.txt, packages/vsx-registry/README.md, packages/vsx-registry/src/node/vsx-environment-impl.ts)
- [S39] `.../build/lib/builtInExtensions.ts?ref=1.144.0`
- [S40] `.../src/vs/platform/extensionManagement/common/extensionGalleryManifestService.ts?ref=1.144.0`; `.../src/vs/workbench/services/extensionManagement/electron-browser/extensionGalleryManifestService.ts?ref=1.144.0`
- [S41] https://github.com/microsoft/pylance-release/issues/4886

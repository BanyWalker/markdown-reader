# Third-Party Notices

MD Reader includes or links to the following third-party software. The exact
versions are pinned in `package-lock.json` and `src-tauri/Cargo.lock`.

## Runtime dependencies

| Component | License |
| --- | --- |
| Tauri, Tauri API, and Tauri opener plugin | Apache-2.0 OR MIT |
| React and React DOM | MIT |
| Markdown-It and Markdown-It plugins | MIT, ISC, or Unlicense (see package metadata) |
| Mermaid | MIT |
| KaTeX | MIT |
| DOMPurify | MPL-2.0 OR Apache-2.0 |
| ECharts | Apache-2.0 |
| highlight.js | BSD-3-Clause |
| rfd | MIT |
| serde and windows-sys | MIT OR Apache-2.0 |

Each dependency package provides its own copyright notice and license text.
The applicable notices and license texts must be retained when redistributing
source or binary releases. This file does not relicense any third-party
component.

## Notable transitive licenses

- Rust dependencies include MPL-2.0 packages such as `cssparser`,
  `cssparser-macros`, `selectors`, `dtoa-short`, and `option-ext`.
- npm dependencies include `argparse` (Python-2.0) and
  `robust-predicates` (Unlicense). `khroma` and `match-at` declare MIT in
  their package license files even though their package metadata is blank.
- Development-only browser data such as `caniuse-lite` is CC-BY-4.0 and is
  not part of the application runtime unless explicitly redistributed.

## Build and platform components

The Windows bundle includes `src-tauri/assets/WebView2Loader.dll`. It is a
Microsoft WebView2 component and is distributed under Microsoft's applicable
WebView2 terms, not this project's MIT License.

The optional `.tools/` LLVM-MinGW toolchain is a build-time distribution with
its own licenses. It is not part of MD Reader and should not be included in a
source or binary release unless its accompanying license files and any other
required notices are retained.

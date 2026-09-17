# Third-party notices

- Electron: MIT; Chromium and related notices accompany the packaged runtime.
- React / React DOM: MIT.
- Lucide icons: ISC.
- react-markdown / remark-gfm: MIT.
- Zod: MIT.
- OpenLayers 10.10.0: BSD-2-Clause; the complete notice is in `licenses/OpenLayers-BSD-2-Clause.txt`. Used as a strictly planar Canvas renderer.
- OpenStreetMap contributors: the map database and its derived files are provided under ODbL 1.0 (`licenses/ODbL-1.0.txt`). Attribution remains visible in the map. A machine-readable geographic source is included at `assets/map-v2/source.osm.json.gz`; provenance and transformations are described in `assets/map-v2/SOURCE.md`.
- osmtogeojson 3.0.0-beta.5: MIT (`licenses/osmtogeojson-MIT.txt`), a development-only JSON conversion tool. The XML dependency is pinned to @xmldom/xmldom 0.9.12; no remote XML is parsed by the map pipeline.
- Noto Sans SC: SIL Open Font License 1.1, copied to `licenses/NotoSansSC-OFL.txt` and included in the desktop package. Font assets are local; no font requests are sent to an external CDN.
- Zhejiang University student-info connector: the app invokes the user-selected external `zju-student-info` skill as a separate read-only process. That source is GPL-3.0 licensed; its source and license remain outside this repository and are not copied into Electron. Keep the upstream `LICENSE` with any local installation and review its terms before redistribution.

Hermes Agent 0.21.2, commit `d595e636c83aa0b9606d4e914e1140ae9c796897`, is distributed as a separate Python sidecar under the MIT license. Its original license is included at `licenses/Hermes-MIT.txt`; narrow host adaptations and their hashes are recorded in the runtime manifest. The upstream agent loop and delegation remain upstream code. Windows packages also include CPython (license at `licenses/Python-LICENSE.txt`) and the dependencies pinned by the upstream `uv.lock`; their package metadata and license files accompany the runtime. No user data or credentials are included.

DeepSeek and Apple are referenced as service and design documentation sources, not as endorsers of this project.

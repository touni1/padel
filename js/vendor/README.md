# Librerías de terceros (sin modificar)

Copiadas de los paquetes oficiales de npm (el hash del paquete se comprobó contra `dist.integrity` del registro), salvo SheetJS, que ya no publica en npm: viene de su CDN oficial, `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (la 0.18.5 de npm tiene vulnerabilidades conocidas).

| Librería | Versión | Archivos | Licencia |
| --- | --- | --- | --- |
| [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) (Mozilla pdf.js) | 6.3.289 | `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs`, `cmaps/`, `standard_fonts/`, `wasm/`, `iccs/` | Apache-2.0 |
| [pdf-lib](https://www.npmjs.com/package/pdf-lib) | 1.17.1 | `pdf-lib/pdf-lib.esm.min.js` | MIT |
| [mammoth](https://www.npmjs.com/package/mammoth) | 1.13.0 | `mammoth/mammoth.browser.min.js` | BSD-2-Clause |
| [SheetJS](https://sheetjs.com) (xlsx) | 0.20.3 | `sheetjs/xlsx.full.min.js` | Apache-2.0 |

Para actualizar: `npm pack <paquete>@<versión>`, comprobar el hash y copiar los mismos archivos.

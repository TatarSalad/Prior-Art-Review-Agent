import { joinSession } from "@github/copilot-sdk/extension";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(extensionDir, "../../..");
const projectPython = join(projectRoot, ".venv", "Scripts", "python.exe");
const pageLimit = 20;
const outputLimit = 35000;

const extractPdfText = String.raw`
import json
import sys
from pathlib import Path
from pypdf import PdfReader

path = Path(sys.argv[1])
start_page = int(sys.argv[2]) if sys.argv[2] else 1
end_page_arg = int(sys.argv[3]) if sys.argv[3] else None

if not path.is_absolute():
    raise ValueError("pdf_path must be an absolute path")
if path.suffix.lower() != ".pdf":
    raise ValueError("The supplied file does not have a .pdf extension")
if not path.is_file():
    raise FileNotFoundError(f"PDF not found: {path}")
if path.stat().st_size > 100 * 1024 * 1024:
    raise ValueError("PDF exceeds the 100 MiB read limit")

reader = PdfReader(str(path), strict=False)
page_count = len(reader.pages)
if page_count == 0:
    raise ValueError("PDF contains no pages")
if start_page < 1 or start_page > page_count:
    raise ValueError(f"start_page must be between 1 and {page_count}")

end_page = end_page_arg if end_page_arg is not None else min(page_count, start_page + 19)
if end_page < start_page or end_page > page_count:
    raise ValueError(f"end_page must be between {start_page} and {page_count}")
if end_page - start_page + 1 > 20:
    raise ValueError("Read at most 20 pages per call; request smaller page ranges")

pages = []
for page_number in range(start_page, end_page + 1):
    try:
        text = reader.pages[page_number - 1].extract_text() or ""
        error = None
    except Exception as exc:
        text = ""
        error = f"Text extraction failed: {type(exc).__name__}: {exc}"
    pages.append({"page": page_number, "text": text, "error": error})

print(json.dumps({"page_count": page_count, "pages": pages}, ensure_ascii=True))
`;

function failure(message) {
    return { textResultForLlm: message, resultType: "failure" };
}

await joinSession({
    tools: [
        {
            name: "read_supplied_pdf",
            description:
                "Extract page-numbered text from a user-supplied local PDF. Read-only; no external access. Reads up to 20 pages per call; specify ranges for longer documents.",
            parameters: {
                type: "object",
                properties: {
                    pdf_path: {
                        type: "string",
                        description: "Absolute path to the user-supplied PDF file",
                    },
                    start_page: {
                        type: "integer",
                        minimum: 1,
                        description: "First page to read (defaults to page 1)",
                    },
                    end_page: {
                        type: "integer",
                        minimum: 1,
                        description:
                            "Last page to read, inclusive (defaults to at most 20 pages)",
                    },
                },
                required: ["pdf_path"],
            },
            handler: async ({ pdf_path, start_page, end_page }) => {
                if (typeof pdf_path !== "string" || !isAbsolute(pdf_path)) {
                    return failure("Provide an absolute path to the supplied PDF.");
                }

                const python = existsSync(projectPython) ? projectPython : "uv";
                const args = existsSync(projectPython)
                    ? [
                          "-c",
                          extractPdfText,
                          pdf_path,
                          start_page ? String(start_page) : "",
                          end_page ? String(end_page) : "",
                      ]
                    : [
                          "run",
                          "--project",
                          projectRoot,
                          "--no-sync",
                          "python",
                          "-c",
                          extractPdfText,
                          pdf_path,
                          start_page ? String(start_page) : "",
                          end_page ? String(end_page) : "",
                      ];

                const result = spawnSync(python, args, {
                    cwd: projectRoot,
                    encoding: "utf8",
                    maxBuffer: 8 * 1024 * 1024,
                    timeout: 60000,
                    windowsHide: true,
                });
                if (result.error) {
                    return failure(`PDF extraction could not start: ${result.error.message}`);
                }
                if (result.status !== 0) {
                    const detail = (result.stderr || result.stdout || "Unknown extraction error").trim();
                    return failure(`PDF extraction failed: ${detail}`);
                }

                let extraction;
                try {
                    extraction = JSON.parse(result.stdout);
                } catch (error) {
                    return failure(`PDF extraction returned invalid output: ${error.message}`);
                }

                const pageText = extraction.pages
                    .map((page) => {
                        const content = page.error
                            ? page.error
                            : page.text.trim() || "[No extractable text on this page; it may be image-only.]";
                        return `--- PDF page ${page.page} ---\n${content}`;
                    })
                    .join("\n\n");
                if (pageText.length > outputLimit) {
                    return failure(
                        `The extracted text exceeds the ${outputLimit}-character response limit. Retry with a smaller page range.`,
                    );
                }

                const firstPage = extraction.pages[0].page;
                const lastPage = extraction.pages.at(-1).page;
                return `PDF has ${extraction.page_count} pages. Extracted pages ${firstPage}-${lastPage} (maximum ${pageLimit} pages per call). Image-only pages are not OCR'd or visually interpreted.\n\n${pageText}`;
            },
        },
    ],
});

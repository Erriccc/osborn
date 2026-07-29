# Skill: Markdown to PDF

Export Markdown documents as formatted PDF files.

## When to use
When the user  /wants to create a PDF from a Markdown file, spec, or research findings.

## How to execute

Option 1 — Using md-to-pdf (best quality):
```bash
npx --yes md-to-pdf "<MARKDOWN_PATH>"
```
This creates a PDF alongside the source file with the same name.

Option 2 — Using pandoc (if available):
```bash
pandoc "<MARKDOWN_PATH>" -o "<OUTPUT_PATH>.pdf" --pdf-engine=wkhtmltopdf
```

Option 3 — Using markdown-pdf:
```bash
npx --yes markdown-pdf "<MARKDOWN_PATH>" -o "<OUTPUT_PATH>.pdf"
```

## Output
- Save the PDF to the session workspace (e.g., `library/{name}.pdf`)
- Confirm the output path and file size to the user
- If the source is spec.md, name the output `spec-export.pdf`

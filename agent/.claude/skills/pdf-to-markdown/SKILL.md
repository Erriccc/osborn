# Skill: PDF to Markdown

Convert PDF documents to readable Markdown text.

## When to use
When the user provides a PDF file path and wants to read, search, or work with its contents.

## How to execute

Option 1 — Using the built-in Read tool:
The Read tool can directly read PDF files. Use `pages` parameter for large PDFs (max 20 pages per request).

Option 2 — Full extraction via CLI (for better formatting or batch processing):
```bash
npx --yes pdf-parse-cli "<PDF_PATH>"
```

Option 3 — Using pdftotext (if available):
```bash
pdftotext -layout "<PDF_PATH>" -
```

## Output
Save the converted content to the session workspace as `library/{filename}.md` with:
- Document title and source path at the top
- Preserved heading structure where detectable
- Tables converted to Markdown tables where possible
- Page numbers as section markers

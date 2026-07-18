# Roadmap

Each milestone should be split into small issues that leave the repository in a
working, verified state.

## 1. Foundation

- Scaffold the pnpm TypeScript workspace
- Configure formatting, linting, strict type checking, tests, and CI
- Create API, worker, and web application shells
- Add SQLite/Prisma plumbing and health checks
- Add local and Docker Compose development workflows

## 2. Manual receipt ledger

- Finalize receipt and money contracts
- Add receipt and line-item persistence
- Implement versioned CRUD endpoints
- Build receipt list, detail, and manual editing screens

## 3. Receipt documents

- Define image/PDF upload constraints and storage layout
- Upload, validate, hash, persist, and display original documents
- Render PDFs into ordered page images and normalize image uploads
- Review multi-page documents without losing page order
- Detect exact duplicate documents

## 4. AI extraction

- Finalize extraction schema and German receipt profile
- Implement the provider boundary and first adapter
- Add database-backed processing jobs and worker behavior
- Validate, reconcile, retry, and retain processing attempts

## 5. Review and categorization

- Build side-by-side document and extraction review
- Highlight validation findings and uncertain fields
- Add categories and correction rules
- Protect approved edits during reprocessing

## 6. Reporting

- Weekly and monthly spending totals
- Category and merchant breakdowns
- Search and date/category/store filters

## 7. Email ingestion

- Choose the initial email integration
- Securely configure credentials
- Fetch candidate messages and image/PDF attachments through the same ingestion
  pipeline used by manual uploads
- Deduplicate and enqueue receipts

## Definition of done for a milestone

- Acceptance criteria for its issues are met
- Formatting, linting, types, tests, and builds pass
- Relevant user workflow is demonstrable
- Documentation and API contracts are current
- Persistent-data migration and backup implications are documented

MASTER MISSION — COMPLETE THE AFRICAN AI AGENT HARNESS

1. PROJECT CONTEXT

You are working on an existing African AI Agent Harness.

This project is intended to become a professional AI infrastructure for businesses, accounting firms, institutions and organizations.

We already have an existing codebase with several developed functionalities, including an invoicing module.

Your mission is to inspect, improve, complete, secure, test and document the entire application.

This is NOT a greenfield project.

Do not rebuild everything from scratch.

Do not destroy existing functionality.

Preserve the existing architecture wherever it is technically sound.

Our immediate commercial objective is to deliver a complete, demonstrable product that can be presented to potential business clients, particularly accounting firms.

You must work as a senior full-stack engineer, AI infrastructure engineer and security engineer.

2. COMPLETE AUDIT

Before implementation:

- Inspect the entire repository.
- Understand the frontend and backend architecture.
- Inspect the database schema and migrations.
- Identify all existing features.
- Identify incomplete features and bugs.
- Identify mocked integrations and placeholder functionality.
- Inspect authentication and authorization.
- Inspect the existing invoicing implementation.
- Inspect payment-related code.
- Inspect environment variables and external services.
- Inspect the Git history and existing tags.

Create an internal implementation checklist.

Then proceed with the actual implementation. Do not stop after producing an audit report.

3. AI AGENT HARNESS

Complete the following infrastructure.

A. System prompts

Users must be able to configure:

- Agent identity and role.
- Instructions and objectives.
- Behavior and communication style.
- Restrictions and boundaries.
- Prompt versions and updates.

Ensure the configured instructions are actually applied during agent execution.

B. RAG infrastructure

Implement a complete Retrieval Augmented Generation pipeline:

- Document ingestion.
- PDF, DOCX and TXT support.
- OCR for scanned documents and images.
- Text extraction.
- Document cleaning.
- Intelligent chunking.
- Embedding generation.
- Vector storage.
- Semantic search.
- Context retrieval.
- Source references.
- Document updates and deletion.
- Organization-level data isolation.

The agent must retrieve relevant information before answering knowledge-dependent questions.

C. MCP infrastructure

Implement:

- MCP server connections.
- Tool discovery.
- Tool descriptions and parameter validation.
- Tool execution.
- Error handling.
- Tool permissions.
- Tool activation and deactivation.
- Human approval for sensitive actions.

D. Native connectors

Prioritize:

Google

- Gmail.
- Google Sheets.
- Google Drive architecture for future expansion.

WhatsApp

- Official WhatsApp Business Platform integration or a supported official provider.
- Receiving messages.
- Sending authorized messages.
- Conversation management.
- Agent interaction through WhatsApp.

Provide an intuitive connection experience using OAuth 2.0 where supported.

Users should be able to connect, authorize, manage and disconnect their integrations.

Never simulate a successful external connection.

E. Authentication and RBAC

Implement:

- User authentication.
- Organization management.
- Role-based access control.
- Administrator and standard user permissions.
- Secure OAuth authorization.
- Organization-level isolation.
- Backend permission enforcement.

An agent must never have greater permissions than the user authorizing its actions.

F. Guardrails

Implement:

- Prompt injection protection.
- Malicious document instruction detection.
- Input validation.
- Sensitive information filtering.
- Personal data protection.
- Output validation.
- Tool execution restrictions.
- Human approval for sensitive operations.

Treat external documents and retrieved content as untrusted input.

G. Model routing and caching

Implement intelligent model selection:

- Lightweight models for simple tasks.
- More powerful models for complex tasks.
- Configurable model providers.
- Fallback mechanisms.
- Cost optimization.
- Secure response caching.

Do not expose token billing to customers as the primary pricing mechanism.

Internal token consumption can still be monitored for our own operational cost management.

H. Observability

Implement:

- Execution traces.
- Prompt and response logs with sensitive data protection.
- Tool execution logs.
- Token consumption.
- Processing duration.
- Error monitoring.
- Cost monitoring.
- Agent evaluations.
- Usage analytics.

4. DOCUMENT PROCESSING AND INVOICE GENERATION

This is one of the most important commercial functionalities.

The application must allow companies to upload documents and have the AI extract the relevant information and generate professional invoices.

Supported inputs should include:

- PDF documents.
- Scanned documents.
- Images.
- Other supported business document formats.

Implement the complete workflow:

1. User uploads a document.
2. System validates the document.
3. OCR extracts information when necessary.
4. AI identifies relevant invoice information.
5. System validates extracted fields.
6. User can review and correct extracted information.
7. Invoice is generated.
8. Invoice is saved in the database.
9. User can download or share the invoice.
10. The document-processing credit is consumed according to the rules defined below.

Do not blindly trust extracted information.

Allow users to review important fields such as:

- Customer name.
- Company information.
- Invoice number.
- Description.
- Quantity.
- Unit price.
- Taxes.
- Total amount.
- Dates.

Implement validation and calculation on the backend.

5. CRITICAL BUSINESS MODEL: DOCUMENT-BASED CREDIT SYSTEM

This is a fundamental part of the business model.

We are NOT going to charge customers according to AI tokens.

We are introducing a prepaid document-processing credit economy.

ONE SUCCESSFULLY GENERATED INVOICE FROM ONE DOCUMENT = ONE CREDIT.

The system must implement the entire credit economy, not just a numerical counter in the interface.

A. Individual company credit wallets

Every organization must have its own credit wallet.

The wallet must contain:

- Available balance.
- Total credits purchased.
- Total credits consumed.
- Total credits refunded.
- Transaction history.

Credit balances must be isolated between organizations.

B. Credit consumption rules

Implement the following business rules:

1. One successfully generated invoice consumes one credit.
2. Failed uploads do not consume credits.
3. Failed OCR operations do not consume credits.
4. Failed AI processing does not consume credits.
5. Failed invoice generation does not consume credits.
6. Retrying the same request must not accidentally deduct another credit.
7. A completed document-processing operation must never be charged twice.
8. A deliberately initiated new invoice generation from another document must be treated as a new operation.

Use unique processing identifiers and idempotency mechanisms.

C. Atomic credit management

This is extremely important.

Implement secure, atomic credit deduction.

The backend must guarantee that:

- Two simultaneous requests cannot spend the same credit.
- A balance cannot become negative.
- A credit cannot be deducted twice for the same operation.
- Failed transactions can be rolled back safely.
- Credit balances remain consistent.

Use appropriate database transactions, row locking or atomic conditional updates depending on the existing database technology.

Do not rely on frontend calculations for financial operations.

D. Credit packages

Create an administrative credit-package management system.

Administrators must be able to configure:

- Package name.
- Number of credits.
- Price.
- Currency.
- Description.
- Availability.
- Promotional packages when needed.

Provide configurable packages, for example:

- 100 credits.
- 500 credits.
- 1,000 credits.
- 5,000 credits.

These are examples, not fixed prices.

The administrator must be able to modify package prices and quantities without changing application code.

E. Purchasing credits through SasPay

Our chosen payment aggregator is:

https://www.saspay.me/

Use SasPay as the payment provider for purchasing document credits.

Study its official API documentation before implementation.

Implement:

- Payment initialization.
- Unique transaction references.
- Secure payment requests.
- Payment status verification.
- Authenticated webhook handling.
- Transaction history.
- Failed payment management.
- Pending payment management.
- Successful payment confirmation.
- Automatic credit allocation after verified payment.

IMPORTANT:

Never add credits simply because a user visits a successful-payment URL.

Only allocate credits after server-side verification of the payment.

Use idempotency to prevent duplicate credit allocation from repeated webhooks.

Store payment secrets securely on the backend.

Verify supported currencies, payment methods and merchant requirements for the Democratic Republic of Congo.

If API credentials or merchant activation are unavailable, complete the integration structure and document the exact remaining requirements.

Do not invent unsupported SasPay API endpoints or capabilities.

F. Credit transaction ledger

Create a permanent, auditable transaction ledger.

Every credit-related operation must create a record containing:

- Transaction identifier.
- Organization identifier.
- Transaction type.
- Credit amount.
- Previous balance.
- New balance.
- Related document or invoice identifier when applicable.
- Payment reference when applicable.
- Timestamp.
- Operation status.

Supported transaction types:

- Credit purchase.
- Document processing deduction.
- Refund.
- Administrative credit allocation.
- Administrative correction.

Do not allow ordinary users to modify ledger records.

Never delete financial history to correct a mistake. Use auditable compensating transactions.

G. Credit dashboard

Create a professional credit management interface.

Users must see:

- Available credits.
- Total credits purchased.
- Credits consumed.
- Recent transactions.
- Document processing history.
- Remaining usage.
- Purchase history.

Provide daily, weekly and monthly usage statistics.

Show notifications when balances become low.

H. Insufficient credits

When a company has insufficient credits:

- Prevent new document processing.
- Explain the situation clearly.
- Display the current balance.
- Provide a way to purchase additional credits.
- Allow processing to resume after successful payment.

Do not charge users for unsuccessful operations.

I. Administration

Administrators must be able to:

- View organizations and their balances.
- Configure credit packages.
- Configure package pricing.
- Inspect credit transactions.
- Allocate promotional credits.
- Issue authorized corrections.
- Inspect document-processing usage.
- Review payment statuses.

Every administrative financial action must be logged.

J. Credit system documentation

Create complete technical and business documentation.

Explain:

- How the credit economy works.
- How a wallet is created.
- How credits are purchased.
- How SasPay payments are verified.
- How credits are allocated.
- How document processing consumes credits.
- How failed operations are handled.
- How refunds work.
- How concurrency is handled.
- How administrators manage the system.

Include database relationships, transaction workflows, API endpoints and examples.

Documentation must be understandable to both developers and business stakeholders.

6. EXISTING INVOICING MODULE

The invoicing module already exists.

Do not rebuild it unnecessarily.

Inspect and complete:

- Invoice creation.
- Invoice numbering.
- Client information.
- Company information.
- Descriptions.
- Quantities.
- Unit prices.
- Subtotals.
- Taxes.
- Discounts.
- Total calculations.
- Payment status.
- Due dates.
- PDF generation.
- Downloading and sharing.
- Invoice history.
- Search and filtering.

Correct all content, descriptions, interface labels, terminology, validation messages and translations.

Make the invoicing module coherent with the new document-credit economy.

Ensure that manually creating invoices and generating invoices from scanned documents follow the appropriate business rules. The one-credit-per-document rule applies to the document-processing workflow, not automatically to every manually created invoice.

7. SECURITY — HIGHEST PRIORITY

Security is not an optional improvement.

Treat this as a commercial SaaS platform that will contain confidential business documents, financial records, customer information and external account connections.

Perform a complete security audit and implement appropriate protections.

Authentication

- Secure password handling.
- Session management.
- Secure authentication flows.
- Token expiration and revocation.
- Protection against brute-force attacks.

Authorization

- RBAC.
- Organization isolation.
- Backend permission checks.
- Least-privilege access.
- Secure connector authorization.

Data protection

- Encryption in transit.
- Encryption at rest where supported.
- Secure secret management.
- Protection of API keys.
- Secure storage of OAuth tokens.
- Sensitive data masking.
- Secure document storage.
- Appropriate retention and deletion policies.

Application security

- SQL injection protection.
- Cross-site scripting protection.
- CSRF protection where applicable.
- SSRF protection.
- Secure file uploads.
- File type and size validation.
- Malware scanning where appropriate.
- Rate limiting.
- Secure API validation.
- Protection against unauthorized access.

AI security

- Prompt injection protection.
- Tool permission boundaries.
- Untrusted document handling.
- Sensitive information filtering.
- Human approval for sensitive actions.

Financial security

- Server-side payment verification.
- Webhook signature verification.
- Idempotent transactions.
- Atomic credit deductions.
- Prevention of duplicate credit allocation.
- Immutable transaction history.
- Administrative audit trails.

Never expose private credentials in frontend code, logs, source control or error messages.

Never trust client-side balances or payment statuses.

Perform security tests before considering the project ready.

8. INTERFACE AND USER EXPERIENCE

Inspect every page and component.

Correct:

- Inconsistent texts.
- Spelling errors.
- Incorrect translations.
- Broken buttons.
- Incomplete forms.
- Empty pages.
- Incorrect notifications.
- Loading states.
- Error states.
- Responsive layout problems.

Maintain the existing visual identity while improving consistency and usability.

The product must feel like a professional SaaS platform.

9. TESTING

Test the entire application.

Required tests include:

- Authentication.
- Permissions.
- Organization isolation.
- Agent execution.
- RAG.
- MCP.
- Connectors.
- Document uploads.
- OCR.
- Invoice generation.
- Credit deduction.
- Credit purchases.
- SasPay integration.
- Webhooks.
- Refunds.
- Concurrent processing.
- Duplicate requests.
- Security boundaries.

Important end-to-end scenario:

A company purchases 100 credits through SasPay.

The payment is verified.

The company receives 100 credits.

It uploads a scanned document.

The system extracts its information and generates an invoice.

Exactly one credit is deducted.

The company now has 99 credits.

The transaction appears in its history.

If invoice generation fails, the company retains its original balance.

Test this entire workflow.

Do not report tests as successful unless they have actually been executed.

10. DOCUMENTATION AND DELIVERY

Create or update project documentation covering:

- Architecture.
- Installation.
- Environment configuration.
- Database setup.
- Migrations.
- AI model configuration.
- RAG infrastructure.
- MCP infrastructure.
- Connectors.
- Authentication and authorization.
- Document processing.
- Invoice generation.
- Credit economy.
- SasPay integration.
- Security.
- Testing.
- Deployment.

Include a dedicated document explaining the business model and the credit system in language understandable to nontechnical business partners.

11. GITHUB VERSIONING AND TAGGING — MANDATORY

This project is version-controlled on GitHub.

All significant modifications made during this mission must be properly tracked and tagged.

Before making changes:

- Inspect the current Git branch.
- Inspect the working tree.
- Inspect existing commits.
- Inspect existing tags.
- Identify any uncommitted user changes.
- Never overwrite or discard unrelated work.

As you implement the project:

1. Organize changes into logical, meaningful commits.
2. Use descriptive commit messages.
3. Keep the Git history understandable.
4. Do not commit secrets, credentials, private keys or sensitive environment files.
5. Update the documentation alongside implementation.
6. Ensure the project passes its relevant tests before tagging.

When the complete implementation is ready:

- Create an appropriate Git release tag.
- Prefer a semantic versioning convention.
- Inspect existing tags and determine the correct next version.
- Use an annotated Git tag containing a meaningful release description.
- Ensure the tag points to the verified final commit.
- Push the tag to the configured GitHub remote if authentication and permissions are available.

Do not overwrite existing tags.

Do not force-push.

Do not tag an incomplete or untested implementation as a stable release.

If external credentials or permissions prevent pushing, create the local tag and document the exact command required to publish it.

At the end, provide:

- Git branch.
- Final commit hash.
- Commit summaries.
- Created release tag.
- Whether the tag was successfully pushed.
- Test results associated with the release.

12. EXECUTION METHOD

Work in phases:

PHASE 1 — Audit and architecture understanding.

PHASE 2 — Bug fixes and completion of existing features.

PHASE 3 — AI Harness infrastructure.

PHASE 4 — Connectors and MCP.

PHASE 5 — Document processing and invoicing.

PHASE 6 — Complete credit economy and SasPay integration.

PHASE 7 — Security hardening.

PHASE 8 — Testing and documentation.

PHASE 9 — Git commits, release tagging and delivery.

Do not stop after an audit.

Do not stop after implementing the frontend.

Do not leave fake buttons or simulated integrations.

Do not ask for approval for every minor implementation decision.

When external credentials are required, continue all work that can be completed independently and clearly identify the remaining requirements.

Do not introduce unnecessary technologies or dependencies.

Preserve existing working functionality.

13. FINAL ACCEPTANCE CRITERIA

The product must have:

- A functioning AI Agent Harness.
- Configurable system prompts.
- Working RAG.
- Working MCP infrastructure.
- Functional connectors where credentials are available.
- Secure authentication and permissions.
- Active guardrails.
- Intelligent model routing.
- Complete observability.
- Working document ingestion and OCR.
- Functional invoice generation.
- Complete document-based credit economy.
- Working SasPay integration in the available environment.
- Transaction history and credit wallets.
- Secure payment verification.
- Professional dashboards.
- Complete technical documentation.
- Successful relevant tests.
- A properly versioned Git release.

FINAL DIRECTIVE

Your responsibility is to deliver the actual product, not an approximation of it.

Think like a senior engineer responsible for a commercial software release.

Prioritize correctness, security, maintainability and real functionality over superficial speed.

Inspect the existing code, make the necessary changes, test them, document them and prepare the release.

Start immediately with the repository audit and continue until all achievable acceptance criteria have been satisfied.
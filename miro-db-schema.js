/**
 * Appeals Doctor — Database Schema Diagram for Miro
 *
 * HOW TO RUN:
 *  1. Open your Miro board in a browser.
 *  2. Open DevTools → Console (F12 / Cmd+Option+J).
 *  3. Paste this entire script and press Enter.
 *  4. Wait ~10–20 seconds for all shapes to appear.
 *
 * Layout:
 *   LEFT AREA  — Local PostgreSQL tables (green header = auth, blue = business,
 *                orange = stores/files, purple = payments, grey = ops/sync)
 *   RIGHT AREA — Salesforce objects synced via API (yellow, dashed border)
 *   ARROWS     — FK relationships (solid) and SF sync links (dashed orange)
 */

(async () => {
  // ─── Helpers ──────────────────────────────────────────────────────────────

  const COL_W = 380;   // shape width
  const GAP_X = 60;    // horizontal gap between columns
  const GAP_Y = 32;    // vertical gap between shapes in the same column

  // Build HTML content for a table card
  function tableHtml(name, description, fields) {
    const rows = fields
      .map(([col, type, note]) => {
        const noteStr = note ? ` <span style="color:#888;font-size:10px">${note}</span>` : '';
        return `<tr>
          <td style="padding:2px 6px;font-size:11px;color:#222;font-family:monospace">${col}</td>
          <td style="padding:2px 6px;font-size:10px;color:#555">${type}${noteStr}</td>
        </tr>`;
      })
      .join('');
    return `<p style="font-size:13px;font-weight:700;margin:0 0 2px 0">${name}</p>
<p style="font-size:10px;color:#666;margin:0 0 6px 0">${description}</p>
<table style="border-collapse:collapse;width:100%">${rows}</table>`;
  }

  // Create a shape and return it
  async function box(content, x, y, height, headerColor, borderColor) {
    return miro.board.createShape({
      content,
      shape: 'rectangle',
      style: {
        fillColor: '#ffffff',
        borderColor: borderColor || '#cccccc',
        borderWidth: 2,
        textAlign: 'left',
        textAlignVertical: 'top',
        fontSize: 12,
        color: '#111111',
      },
      x, y,
      width: COL_W,
      height,
    });
  }

  // Section header label
  async function sectionLabel(text, x, y, color) {
    return miro.board.createText({
      content: `<p style="font-weight:800;font-size:16px;color:${color}">${text}</p>`,
      style: {},
      x, y,
      width: COL_W,
    });
  }

  // Connector between two shapes
  async function connect(startId, endId, label, dashed) {
    return miro.board.createConnector({
      shape: 'elbowed',
      style: {
        startStrokeCap: 'none',
        endStrokeCap: 'filled_triangle',
        strokeColor: dashed ? '#e67e22' : '#555555',
        strokeWidth: dashed ? 1.5 : 1.5,
        strokeStyle: dashed ? 'dashed' : 'normal',
      },
      start: { item: startId },
      end: { item: endId },
      captions: label ? [{ content: label, position: 0.5 }] : [],
    });
  }

  // ─── Column X positions ────────────────────────────────────────────────────
  const C1 = -1900; // Auth
  const C2 = -1440; // Accounts
  const C3 = -980;  // Stores
  const C4 = -520;  // Docs & Cases
  const C5 = -60;   // Payments
  const C6 =  400;  // Ops / Sync
  const SF_START = 1000; // Salesforce columns
  const C7 = SF_START;
  const C8 = SF_START + COL_W + GAP_X;
  const C9 = SF_START + (COL_W + GAP_X) * 2;

  // ─── SECTION LABELS ────────────────────────────────────────────────────────
  const Y_LABEL = -700;
  await sectionLabel('🔐 Auth & Sessions', C1, Y_LABEL, '#27ae60');
  await sectionLabel('🏢 Accounts & Users', C2, Y_LABEL, '#2980b9');
  await sectionLabel('🛒 Stores & SP-API', C3, Y_LABEL, '#e67e22');
  await sectionLabel('📄 Documents & Cases', C4, Y_LABEL, '#8e44ad');
  await sectionLabel('💳 Payments', C5, Y_LABEL, '#c0392b');
  await sectionLabel('⚙️ Ops / Sync', C6, Y_LABEL, '#7f8c8d');
  await sectionLabel('☁️  Salesforce Objects (via API)', SF_START + (COL_W + GAP_X), Y_LABEL, '#d35400');

  // ─── AUTH COLUMN ───────────────────────────────────────────────────────────
  let y = -600;

  const sUsers = await box(tableHtml('users', 'Primary auth table — one row per registered user', [
    ['id',                 'UUID PK',   ''],
    ['email',             'TEXT UNIQUE','login identifier'],
    ['display_name',      'TEXT',      ''],
    ['avatar_url',        'TEXT',      ''],
    ['password_hash',     'TEXT',      'null for OAuth-only users'],
    ['role',              'TEXT',      "'owner'|'admin'|'member'"],
    ['account_id',        'UUID FK',   '→ accounts'],
    ['sfdc_contact_id',   'TEXT',      'Salesforce Contact Id'],
    ['sfdc_account_id',   'TEXT',      'Salesforce Account Id'],
    ['is_active',         'BOOL',      ''],
    ['last_login_at',     'TIMESTAMPTZ',''],
    ['created_at',        'TIMESTAMPTZ',''],
  ]), C1, y, 400, '#27ae60');
  y += 400 + GAP_Y;

  const sSessions = await box(tableHtml('sessions', 'DB-backed sessions for revocation support (3h TTL)', [
    ['id',         'UUID PK', ''],
    ['user_id',    'UUID FK', '→ users'],
    ['token_hash', 'TEXT',    'SHA-256 of JWT cookie'],
    ['expires_at', 'TIMESTAMPTZ',''],
    ['ip_address', 'INET',   ''],
    ['user_agent', 'TEXT',   ''],
    ['created_at', 'TIMESTAMPTZ',''],
  ]), C1, y, 260, '#27ae60');
  y += 260 + GAP_Y;

  const sOAuth = await box(tableHtml('oauth_accounts', 'OAuth provider links (Google etc.) attached to a user', [
    ['id',            'UUID PK', ''],
    ['user_id',       'UUID FK', '→ users'],
    ['provider',      'TEXT',    "'google'|'apple'"],
    ['provider_uid',  'TEXT',    'provider user ID'],
    ['access_token',  'TEXT',    ''],
    ['refresh_token', 'TEXT',    ''],
    ['expires_at',    'TIMESTAMPTZ',''],
  ]), C1, y, 256, '#27ae60');
  y += 256 + GAP_Y;

  const sPRT = await box(tableHtml('password_reset_tokens', 'Single-use tokens for forgot-password flow (1h TTL)', [
    ['id',         'UUID PK', ''],
    ['user_id',    'UUID FK', '→ users'],
    ['email',      'TEXT',    'snapshot at creation'],
    ['token_hash', 'TEXT',    'SHA-256 of raw token'],
    ['expires_at', 'TIMESTAMPTZ','now() + 1h'],
    ['used_at',    'TIMESTAMPTZ','null = unused'],
    ['created_at', 'TIMESTAMPTZ',''],
  ]), C1, y, 260, '#27ae60');

  // ─── ACCOUNTS COLUMN ───────────────────────────────────────────────────────
  y = -600;

  const sAccounts = await box(tableHtml('accounts', 'Company/customer accounts — mirrors Salesforce Account', [
    ['id',                  'UUID PK',  ''],
    ['name',                'TEXT',     'company name'],
    ['email',               'TEXT',     ''],
    ['phone',               'TEXT',     ''],
    ['website',             'TEXT',     ''],
    ['sfdc_account_id',     'TEXT UNIQUE','Salesforce Account Id'],
    ['billing_street',      'TEXT',     ''],
    ['billing_city',        'TEXT',     ''],
    ['billing_state',       'TEXT',     ''],
    ['billing_postal_code', 'TEXT',     ''],
    ['billing_country',     'TEXT',     ''],
    ['created_at',          'TIMESTAMPTZ',''],
    ['updated_at',          'TIMESTAMPTZ',''],
  ]), C2, y, 430, '#2980b9');
  y += 430 + GAP_Y;

  const sAContacts = await box(tableHtml('account_contacts', 'Additional contacts on an account — mirrors SF Contact. Supports point-of-contact + invite flow', [
    ['id',                   'UUID PK', ''],
    ['account_id',           'UUID FK', '→ accounts'],
    ['user_id',              'UUID FK', '→ users (null until registered)'],
    ['first_name',           'TEXT',    ''],
    ['last_name',            'TEXT',    ''],
    ['email',                'TEXT',    ''],
    ['phone',                'TEXT',    ''],
    ['title',                'TEXT',    'job title'],
    ['is_point_of_contact',  'BOOL',    'max 1 per account'],
    ['sfdc_contact_id',      'TEXT',    'Salesforce Contact Id'],
    ['invite_token',         'TEXT',    'pending invite (hashed)'],
    ['invite_sent_at',       'TIMESTAMPTZ',''],
    ['invite_accepted_at',   'TIMESTAMPTZ',''],
    ['created_by',           'UUID FK', '→ users'],
    ['created_at',           'TIMESTAMPTZ',''],
  ]), C2, y, 470, '#2980b9');

  // ─── STORES COLUMN ─────────────────────────────────────────────────────────
  y = -600;

  const sStores = await box(tableHtml('stores', 'Amazon seller stores — mirrors Salesforce Store__c. Holds SP-API OAuth state', [
    ['id',                           'UUID PK',   ''],
    ['account_id',                   'UUID FK',   '→ accounts'],
    ['created_by',                   'UUID FK',   '→ users'],
    ['name',                         'TEXT',      'store display name'],
    ['marketplaces',                 'TEXT',      "';'-joined picklist"],
    ['seller_id',                    'TEXT',      'Amazon Seller ID'],
    ['seller_primary_email',         'TEXT',      ''],
    ['store_email',                  'TEXT',      ''],
    ['business_name',                'TEXT',      ''],
    ['country',                      'TEXT',      ''],
    ['sfdc_store_id',                'TEXT UNIQUE','Salesforce Store__c Id'],
    ['spapi_status',                 'TEXT',      "'disconnected'|'connected'|'error'"],
    ['spapi_refresh_token',          'TEXT',      'long-lived LWA token'],
    ['spapi_access_token',           'TEXT',      'short-lived; lazy-refreshed'],
    ['spapi_access_token_expires_at','TIMESTAMPTZ',''],
    ['spapi_connected_seller_id',    'TEXT',      ''],
    ['spapi_callback_params',        'JSONB',     'raw OAuth callback audit'],
    ['spapi_last_error',             'TEXT',      ''],
    ['created_at',                   'TIMESTAMPTZ',''],
    ['updated_at',                   'TIMESTAMPTZ',''],
  ]), C3, y, 600, '#e67e22');
  y += 600 + GAP_Y;

  const sOAuthStates = await box(tableHtml('spapi_oauth_states', 'Ephemeral CSRF tokens for Amazon LWA OAuth handoff (~10min TTL)', [
    ['state',      'TEXT PK',   'random opaque token sent to Amazon'],
    ['store_id',   'UUID FK',   '→ stores'],
    ['user_id',    'UUID FK',   '→ users'],
    ['created_at', 'TIMESTAMPTZ',''],
    ['expires_at', 'TIMESTAMPTZ',''],
  ]), C3, y, 220, '#e67e22');

  // ─── DOCUMENTS & CASES COLUMN ──────────────────────────────────────────────
  y = -600;

  const sCaseDocs = await box(tableHtml('case_documents', 'Files uploaded against a Salesforce Case. Bytes in S3. Mirrors Case_File__c upload slots', [
    ['id',               'UUID PK', ''],
    ['store_id',         'UUID FK', '→ stores (tenancy)'],
    ['sfdc_case_id',     'TEXT',    'Salesforce Case Id (no local FK)'],
    ['sfdc_case_file_id','TEXT',    'Salesforce Case_File__c Id (required slot)'],
    ['uploaded_by',      'UUID FK', '→ users'],
    ['original_name',    'TEXT',    ''],
    ['s3_bucket',        'TEXT',    ''],
    ['s3_key',           'TEXT',    ''],
    ['mime_type',        'TEXT',    ''],
    ['size_bytes',       'BIGINT',  ''],
    ['created_at',       'TIMESTAMPTZ',''],
  ]), C4, y, 360, '#8e44ad');
  y += 360 + GAP_Y;

  const sStoreDocs = await box(tableHtml('store_documents', 'Files uploaded at store level (not tied to a case). Also mirrors Case_File__c (store-level slots)', [
    ['id',               'UUID PK', ''],
    ['store_id',         'UUID FK', '→ stores'],
    ['uploaded_by',      'UUID FK', '→ users'],
    ['sfdc_case_file_id','TEXT',    'Salesforce Case_File__c Id'],
    ['original_name',    'TEXT',    ''],
    ['s3_bucket',        'TEXT',    ''],
    ['s3_key',           'TEXT',    ''],
    ['storage_path',     'TEXT',    'legacy dev path (pre-S3)'],
    ['mime_type',        'TEXT',    ''],
    ['size_bytes',       'BIGINT',  ''],
    ['created_at',       'TIMESTAMPTZ',''],
  ]), C4, y, 360, '#8e44ad');

  // ─── PAYMENTS COLUMN ───────────────────────────────────────────────────────
  y = -600;

  const sSC = await box(tableHtml('service_contracts', 'One row per Stripe purchase. Synced to Salesforce ServiceContract after payment', [
    ['id',                         'UUID PK', ''],
    ['account_id',                 'UUID FK', '→ accounts'],
    ['user_id',                    'UUID FK', '→ users'],
    ['store_id',                   'UUID FK', '→ stores'],
    ['stripe_payment_intent_id',   'TEXT UNIQUE','idempotency key'],
    ['stripe_charge_id',           'TEXT',    ''],
    ['stripe_payment_method_type', 'TEXT',    ''],
    ['stripe_receipt_email',       'TEXT',    ''],
    ['amount_cents',               'BIGINT',  ''],
    ['currency',                   'TEXT',    ''],
    ['paid_at',                    'TIMESTAMPTZ',''],
    ['start_date',                 'DATE',    ''],
    ['end_date',                   'DATE',    ''],
    ['term_months',                'INT',     'default 3'],
    ['sfdc_service_contract_id',   'TEXT UNIQUE','Salesforce ServiceContract Id'],
    ['sfdc_account_id',            'TEXT',    ''],
    ['sfdc_contact_id',            'TEXT',    ''],
    ['sync_status',                'TEXT',    "'pending'|'synced'|'failed'"],
    ['sync_error',                 'TEXT',    ''],
    ['synced_at',                  'TIMESTAMPTZ',''],
    ['created_at',                 'TIMESTAMPTZ',''],
  ]), C5, y, 620, '#c0392b');
  y += 620 + GAP_Y;

  const sSCL = await box(tableHtml('service_contract_line_items', 'What was purchased — one row per product/service in the cart', [
    ['id',                         'UUID PK', ''],
    ['service_contract_id',        'UUID FK', '→ service_contracts'],
    ['product_name',               'TEXT',    ''],
    ['product_description',        'TEXT',    ''],
    ['product_category',           'TEXT',    ''],
    ['sfdc_product_id',            'TEXT',    'Salesforce Product2 Id'],
    ['sfdc_pricebook_entry_id',    'TEXT',    'Salesforce PricebookEntry Id'],
    ['unit_price',                 'NUMERIC', ''],
    ['quantity',                   'INT',     ''],
    ['currency',                   'TEXT',    ''],
    ['sfdc_contract_line_item_id', 'TEXT',    'Salesforce ContractLineItem Id'],
    ['created_at',                 'TIMESTAMPTZ',''],
  ]), C5, y, 380, '#c0392b');

  // ─── OPS / SYNC COLUMN ─────────────────────────────────────────────────────
  y = -600;

  const sErrLog = await box(tableHtml('error_log', 'Structured error sink for all subsystems. Never throws — write failures go to stdout', [
    ['id',            'UUID PK', ''],
    ['source',        'TEXT',    "'salesforce.sync'|'register'|'login'…"],
    ['operation',     'TEXT',    "'create_account'|'lookup_user'…"],
    ['severity',      'TEXT',    "'error'|'warn'"],
    ['user_id',       'UUID FK', '→ users (SET NULL on delete)'],
    ['account_id',    'UUID FK', '→ accounts (SET NULL on delete)'],
    ['sfdc_object',   'TEXT',    "'Account'|'Contact'|null"],
    ['error_code',    'TEXT',    'SF error code or HTTP status'],
    ['error_message', 'TEXT',    ''],
    ['context',       'JSONB',   'extra structured data (no secrets)'],
    ['stack',         'TEXT',    ''],
    ['created_at',    'TIMESTAMPTZ',''],
  ]), C6, y, 380, '#7f8c8d');
  y += 380 + GAP_Y;

  const sSyncQ = await box(tableHtml('sfdc_sync_queue', 'Outbound Salesforce write queue. Used when real-time sync fails at registration — worker retries', [
    ['id',           'UUID PK', ''],
    ['operation',    'TEXT',    "'upsert'|'delete'"],
    ['sfdc_object',  'TEXT',    "'Account'|'Contact'|…"],
    ['record_id',    'TEXT',    'local or SF ID'],
    ['payload',      'JSONB',   'fields to write to SF'],
    ['status',       'TEXT',    "'pending'|'processing'|'done'|'failed'"],
    ['attempts',     'INT',     ''],
    ['last_error',   'TEXT',    ''],
    ['created_at',   'TIMESTAMPTZ',''],
    ['processed_at', 'TIMESTAMPTZ',''],
  ]), C6, y, 330, '#7f8c8d');
  y += 330 + GAP_Y;

  const sSFRec = await box(tableHtml('sfdc_records', 'Local cache of Salesforce record snapshots. Keyed by Salesforce Id', [
    ['sfdc_id',     'TEXT PK',   'Salesforce record Id'],
    ['object_type', 'TEXT',      "'Account'|'Contact'|…"],
    ['data',        'JSONB',     'full record snapshot'],
    ['synced_at',   'TIMESTAMPTZ',''],
  ]), C6, y, 200, '#7f8c8d');
  y += 200 + GAP_Y;

  const sActLog = await box(tableHtml('activity_log', 'Audit / analytics events. SET NULL on user/session delete to preserve history', [
    ['id',          'UUID PK', ''],
    ['user_id',     'UUID FK', '→ users (SET NULL)'],
    ['session_id',  'UUID',    '(not FK — sessions are purged)'],
    ['event_type',  'TEXT',    "'login'|'page_view'|'action'"],
    ['event_data',  'JSONB',   'screen name, metadata'],
    ['ip_address',  'INET',    ''],
    ['created_at',  'TIMESTAMPTZ',''],
  ]), C6, y, 256, '#7f8c8d');

  // ─── SALESFORCE OBJECTS ─────────────────────────────────────────────────────
  // These live entirely in Salesforce — no local table. Accessed via REST API.

  const sfStyle = {
    fillColor: '#fff8f0',
    borderColor: '#e67e22',
    borderWidth: 2,
    textAlign: 'left',
    textAlignVertical: 'top',
    fontSize: 12,
    color: '#111111',
  };

  async function sfBox(content, x, y, height) {
    return miro.board.createShape({
      content,
      shape: 'rectangle',
      style: sfStyle,
      x, y,
      width: COL_W,
      height,
    });
  }

  y = -600;

  const sfAccount = await sfBox(tableHtml('SF Account ☁️', 'Salesforce standard object — mirrors accounts table. Created/updated at registration and account-edit', [
    ['Id',               'SF Id',   '→ accounts.sfdc_account_id'],
    ['Name',             'TEXT',    '← accounts.name'],
    ['Phone',            'TEXT',    '← accounts.phone'],
    ['Website',          'TEXT',    '← accounts.website'],
    ['Primary_Email__c', 'TEXT',    '← accounts.email (custom field)'],
    ['Start_Date__c',    'DATE',    '← accounts.created_at'],
    ['BillingStreet…',   'TEXT',    '← accounts.billing_*'],
    ['appealsdoctor_vuid__c','TEXT','← accounts.id (back-reference)'],
  ]), C7, y, 290);
  y += 290 + GAP_Y;

  const sfContact = await sfBox(tableHtml('SF Contact ☁️', 'One per user (primary) and per account_contact. Linked to Account via AccountId', [
    ['Id',         'SF Id', '→ users.sfdc_contact_id / account_contacts.sfdc_contact_id'],
    ['AccountId',  'SF Id', '→ SF Account'],
    ['FirstName',  'TEXT',  ''],
    ['LastName',   'TEXT',  ''],
    ['Email',      'TEXT',  ''],
    ['Phone',      'TEXT',  ''],
    ['appealsdoctor_vuid__c','TEXT','← users.id (back-reference)'],
  ]), C7, y, 270);
  y += 270 + GAP_Y;

  const sfStore = await sfBox(tableHtml('SF Store__c ☁️', 'Custom object — mirrors stores table. Created when user adds a store', [
    ['Id',                              'SF Id', '→ stores.sfdc_store_id'],
    ['Name',                            'TEXT',  '← stores.name'],
    ['Marketplaces__c',                 'TEXT',  '← stores.marketplaces'],
    ['Seller_ID__c',                    'TEXT',  '← stores.seller_id'],
    ['Seller_Account_Primary_Email__c', 'TEXT',  ''],
    ['Store_Email__c',                  'TEXT',  ''],
    ['Business_Name__c',                'TEXT',  ''],
    ['Country__c',                      'TEXT',  ''],
    ['appealsdoctor_vuid__c',           'TEXT',  '← stores.id'],
  ]), C7, y, 290);

  // Column 8: Cases, Pricebook
  y = -600;

  const sfCase = await sfBox(tableHtml('SF Case ☁️', 'Standard Salesforce Case object. Referenced by case_documents — never mirrored locally. Fetched live per store', [
    ['Id',      'SF Id', '→ case_documents.sfdc_case_id'],
    ['Subject', 'TEXT',  ''],
    ['Status',  'TEXT',  ''],
    ['AccountId','SF Id',''],
    ['Store__c','SF Id', '→ SF Store__c (custom lookup)'],
  ]), C8, y, 230);
  y += 230 + GAP_Y;

  const sfCaseFile = await sfBox(tableHtml('SF Case_File__c ☁️', 'Custom object — defines required document slots for a Case or Store. Mirrored as case_documents / store_documents upload rows', [
    ['Id',         'SF Id', '→ case_documents.sfdc_case_file_id / store_documents.sfdc_case_file_id'],
    ['Case__c',    'SF Id', '→ SF Case (null for store-level)'],
    ['Store__c',   'SF Id', '→ SF Store__c'],
    ['Name',       'TEXT',  'document label shown to user'],
    ['Required__c','BOOL',  ''],
  ]), C8, y, 240);
  y += 240 + GAP_Y;

  const sfPricebook = await sfBox(tableHtml('SF Pricebook2 / PricebookEntry / Product2 ☁️', 'Standard SF catalog objects. Fetched at checkout to populate the product list and prices. IDs stored in service_contract_line_items', [
    ['Pricebook2.Id',      'SF Id', '→ service_contracts.sfdc_pricebook2_id'],
    ['PricebookEntry.Id',  'SF Id', '→ line_items.sfdc_pricebook_entry_id'],
    ['Product2.Id',        'SF Id', '→ line_items.sfdc_product_id'],
    ['Product2.Name',      'TEXT',  '← line_items.product_name'],
    ['UnitPrice',          'NUMBER','← line_items.unit_price'],
  ]), C8, y, 240);

  // Column 9: ServiceContract
  y = -600;

  const sfSC = await sfBox(tableHtml('SF ServiceContract ☁️', 'Standard SF object. Created after Stripe payment succeeds. Mirrors service_contracts row', [
    ['Id',         'SF Id', '→ service_contracts.sfdc_service_contract_id'],
    ['AccountId',  'SF Id', '→ SF Account'],
    ['Pricebook2Id','SF Id',''],
    ['StartDate',  'DATE',  ''],
    ['EndDate',    'DATE',  ''],
    ['Status',     'TEXT',  ''],
  ]), C9, y, 240);
  y += 240 + GAP_Y;

  const sfCLI = await sfBox(tableHtml('SF ContractLineItem ☁️', 'One per product purchased. Child of ServiceContract. Mirrors service_contract_line_items', [
    ['Id',                'SF Id', '→ line_items.sfdc_contract_line_item_id'],
    ['ServiceContractId', 'SF Id', '→ SF ServiceContract'],
    ['PricebookEntryId',  'SF Id', ''],
    ['Quantity',          'NUMBER',''],
    ['UnitPrice',         'NUMBER',''],
  ]), C9, y, 220);
  y += 220 + GAP_Y;

  const sfEmail = await sfBox(tableHtml('SF emailSimple Action ☁️', 'Standard invocable action called by forgot-password flow. Salesforce handles delivery via its own email infrastructure', [
    ['emailAddresses',    'TEXT', 'recipient'],
    ['emailSubject',      'TEXT', ''],
    ['emailBody',         'TEXT', ''],
    ['senderDisplayName', 'TEXT', "'Appeals Doctor'"],
  ]), C9, y, 200);

  // ─── LOCAL FK RELATIONSHIPS ─────────────────────────────────────────────────
  console.log('Drawing relationships…');

  // Auth cluster
  await connect(sSessions.id,   sUsers.id,    'user_id',    false);
  await connect(sOAuth.id,      sUsers.id,    'user_id',    false);
  await connect(sPRT.id,        sUsers.id,    'user_id',    false);

  // Users ↔ Accounts
  await connect(sUsers.id,      sAccounts.id, 'account_id', false);

  // Accounts cluster
  await connect(sAContacts.id,  sAccounts.id, 'account_id', false);
  await connect(sAContacts.id,  sUsers.id,    'user_id',    false);

  // Stores
  await connect(sStores.id,     sAccounts.id, 'account_id', false);
  await connect(sOAuthStates.id,sStores.id,   'store_id',   false);

  // Documents
  await connect(sCaseDocs.id,   sStores.id,   'store_id',   false);
  await connect(sStoreDocs.id,  sStores.id,   'store_id',   false);

  // Payments
  await connect(sSC.id,         sAccounts.id, 'account_id', false);
  await connect(sSC.id,         sStores.id,   'store_id',   false);
  await connect(sSCL.id,        sSC.id,       'service_contract_id', false);

  // Ops
  await connect(sErrLog.id,     sUsers.id,    'user_id',    false);
  await connect(sErrLog.id,     sAccounts.id, 'account_id', false);

  // ─── SALESFORCE SYNC LINKS (dashed orange) ─────────────────────────────────
  await connect(sAccounts.id,   sfAccount.id, 'sfdc_account_id', true);
  await connect(sUsers.id,      sfContact.id, 'sfdc_contact_id', true);
  await connect(sAContacts.id,  sfContact.id, 'sfdc_contact_id', true);
  await connect(sStores.id,     sfStore.id,   'sfdc_store_id',   true);
  await connect(sCaseDocs.id,   sfCase.id,    'sfdc_case_id',    true);
  await connect(sCaseDocs.id,   sfCaseFile.id,'sfdc_case_file_id',true);
  await connect(sStoreDocs.id,  sfCaseFile.id,'sfdc_case_file_id',true);
  await connect(sSC.id,         sfSC.id,      'sfdc_service_contract_id', true);
  await connect(sSCL.id,        sfCLI.id,     'sfdc_contract_line_item_id', true);
  await connect(sSCL.id,        sfPricebook.id,'sfdc_pricebook_entry_id', true);

  // SF internal links
  await connect(sfContact.id,   sfAccount.id, 'AccountId',  true);
  await connect(sfStore.id,     sfAccount.id, 'Account__c', true);
  await connect(sfCase.id,      sfStore.id,   'Store__c',   true);
  await connect(sfCaseFile.id,  sfCase.id,    'Case__c',    true);
  await connect(sfSC.id,        sfAccount.id, 'AccountId',  true);
  await connect(sfCLI.id,       sfSC.id,      'ServiceContractId', true);
  await connect(sfCLI.id,       sfPricebook.id,'PricebookEntryId', true);

  // ─── LEGEND ────────────────────────────────────────────────────────────────
  await miro.board.createShape({
    content: `<p style="font-weight:700;font-size:13px;margin-bottom:6px">Legend</p>
<p style="font-size:11px">── solid arrow → PostgreSQL FK relationship</p>
<p style="font-size:11px;color:#e67e22">- - dashed orange → Salesforce sync / API link</p>
<p style="font-size:11px">☁️ yellow/dashed boxes → Salesforce objects (no local table)</p>
<p style="font-size:11px;margin-top:6px;color:#555">All local tables live in PostgreSQL (Porsager postgres client).<br>
Salesforce objects are accessed via JWT Bearer REST API.<br>
Files stored in AWS S3 (presigned URLs for download).<br>
SP-API (Amazon) OAuth tokens stored in stores table.</p>`,
    shape: 'rectangle',
    style: { fillColor: '#f8f9fa', borderColor: '#aaaaaa', borderWidth: 1, textAlign: 'left', textAlignVertical: 'top', fontSize: 12 },
    x: C1, y: 1200, width: 700, height: 200,
  });

  console.log('✅ Appeals Doctor DB schema diagram created!');
  alert('✅ Done! The database schema diagram has been added to your Miro board.');
})();

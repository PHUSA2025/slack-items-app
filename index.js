// index.js — Slack Bolt app: /newitem modal (Item→Description dependent) + Workflow Webhook (Slack List)
// Node 18+ recommended (global fetch). CommonJS (require) style.

const { App } = require("@slack/bolt");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

// ===== Env =====
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const WORKFLOW_WEBHOOK_URL = process.env.WORKFLOW_WEBHOOK_URL;

const XLSX_PATH =
  process.env.XLSX_PATH || path.resolve(__dirname, "Items and description (1).xlsx");
const JOB_COUNTER_FILE =
  process.env.JOB_COUNTER_FILE || path.resolve(__dirname, "job_counter.json");

// ===== Helpers =====
function safeReadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  return fallback;
}

function nextJobFromCounter() {
  const data = safeReadJSON(JOB_COUNTER_FILE, { last: 0 });
  const next = (Number.isFinite(data.last) ? data.last : 0) + 1;
  try {
    fs.writeFileSync(JOB_COUNTER_FILE, JSON.stringify({ last: next }, null, 2), "utf8");
  } catch {}
  return next;
}

// Load Items→Descriptions from Excel
function loadItemsMapFromXlsx() {
  if (!fs.existsSync(XLSX_PATH)) {
    console.warn("[itemsMap] XLSX not found:", XLSX_PATH);
    return {
      "Stickers": ["Kiss Cut", "Die Cut", "Sheet", "Roll", "Custom"],
      "Business Cards": ["Matte", "Glossy", "Soft Touch", "Rounded Corners", "Custom"]
    };
  }
  const wb = XLSX.readFile(XLSX_PATH);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // detect columns
  let itemCol = null, descCol = null;
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    itemCol = cols.find(c => /item/i.test(c)) || cols[0];
    descCol = cols.find(c => /desc/i.test(c)) || cols[1] || cols[0];
  }

  const map = {};
  for (const r of rows) {
    const it = String(r[itemCol] || "").trim();
    const de = String(r[descCol] || "").trim();
    if (!it || !de) continue;
    (map[it] ||= new Set()).add(de);
  }

  const out = {};
  for (const k of Object.keys(map)) {
    const arr = Array.from(map[k]).sort();
    if (!arr.includes("Custom")) arr.push("Custom");
    out[k] = arr;
  }
  return Object.keys(out).length ? out : {
    "Stickers": ["Kiss Cut", "Die Cut", "Sheet", "Roll", "Custom"]
  };
}

const itemsMap = loadItemsMapFromXlsx();

// Build modal
function buildModalBlocks(nextJob) {
  const itemOptions = Object.keys(itemsMap).sort().map(v => ({
    text: { type: "plain_text", text: v },
    value: v
  }));

  // Utility: simple select with fallback option
  const mkSelect = (label, block_id, optionsArr) => ({
    type: "input",
    block_id,
    label: { type: "plain_text", text: label },
    element: {
      type: "static_select",
      action_id: block_id,
      placeholder: { type: "plain_text", text: `Choose ${label.toLowerCase()}` },
      options: (optionsArr && optionsArr.length ? optionsArr : ["—"]).map(o => ({
        text: { type: "plain_text", text: o }, value: o
      }))
    }
  });

  return [
    {
      type: "input",
      block_id: "jobNumber",
      label: { type: "plain_text", text: "Job #" },
      element: {
        type: "plain_text_input",
        action_id: "jobNumber",
        initial_value: `#${nextJob}`
      }
    },

    // Client fields
    { type: "input", block_id: "client", label: { type: "plain_text", text: "Client" },
      element: { type: "plain_text_input", action_id: "client" } },

    { type: "input", block_id: "clientEmail", label: { type: "plain_text", text: "Client Email" },
      element: { type: "email_text_input", action_id: "clientEmail" } },

    { type: "input", block_id: "quantity", label: { type: "plain_text", text: "Quantity" },
      element: { type: "plain_text_input", action_id: "quantity" } },

    { type: "input", block_id: "size", label: { type: "plain_text", text: "Size" }, optional: true,
      element: { type: "plain_text_input", action_id: "size" } },

    { type: "input", block_id: "invoice", label: { type: "plain_text", text: "Invoice" }, optional: true,
      element: { type: "plain_text_input", action_id: "invoice" } },

    { type: "input", block_id: "folderLink", label: { type: "plain_text", text: "Folder Link" }, optional: true,
      element: { type: "url_text_input", action_id: "folderLink" } },

    { type: "input", block_id: "notes", label: { type: "plain_text", text: "Notes" }, optional: true,
      element: { type: "plain_text_input", action_id: "notes", multiline: true } },

    { type: "input", block_id: "manufactureNotes", label: { type: "plain_text", text: "Manufacture Notes" }, optional: true,
      element: { type: "plain_text_input", action_id: "manufactureNotes", multiline: true } },

    { type: "input", block_id: "deliveryAddress", label: { type: "plain_text", text: "Delivery Address" }, optional: true,
      element: { type: "plain_text_input", action_id: "deliveryAddress", multiline: true } },

    { type: "input", block_id: "tracking", label: { type: "plain_text", text: "Track #CONF." }, optional: true,
      element: { type: "plain_text_input", action_id: "tracking" } },

    { type: "input", block_id: "designTime", label: { type: "plain_text", text: "Design Time" }, optional: true,
      element: { type: "plain_text_input", action_id: "designTime" } },

    // Dates
    { type: "input", block_id: "date", label: { type: "plain_text", text: "Date" }, optional: true,
      element: { type: "datepicker", action_id: "date" } },

    { type: "input", block_id: "deadline", label: { type: "plain_text", text: "Deadline" }, optional: true,
      element: { type: "datepicker", action_id: "deadline" } },

    // Status selects (put placeholders for now; you can replace with your own arrays)
    mkSelect("Status", "status", ["OPEN", "IN PROGRESS", "COMPLETED", "CANCELLED"]),
    mkSelect("Payment Status", "paymentStatus", ["PAID", "UNPAID", "PARTIAL"]),
    mkSelect("Manufacture", "manufacture", ["PHUSA", "City Colors", "Other"]),
    mkSelect("Second Manufacture", "secondManufacture", ["—", "PHUSA", "City Colors", "Other"]),

    // Items: top-level
    {
      type: "input",
      block_id: "item",
      label: { type: "plain_text", text: "Item" },
      element: {
        type: "static_select",
        action_id: "item",
        placeholder: { type: "plain_text", text: "Choose item" },
        options: itemOptions
      }
    },

    // Description: dependent; will be populated on item change
    {
      type: "input",
      block_id: "description",
      label: { type: "plain_text", text: "Description" },
      element: {
        type: "static_select",
        action_id: "description",
        placeholder: { type: "plain_text", text: "Choose description" },
        options: [] // filled by app.action("item")
      }
    }
  ];
}

function updateBlocksWithDescriptions(blocks, item) {
  const descOptions = (itemsMap[item] || []).map(v => ({
    text: { type: "plain_text", text: v }, value: v
  }));
  return blocks.map(b =>
    b.block_id === "description"
      ? { ...b, element: { ...b.element, options: descOptions } }
      : b
  );
}

// POST to Workflow webhook (adds row to Slack List)
async function postToWorkflow(payload) {
  if (!WORKFLOW_WEBHOOK_URL) throw new Error("WORKFLOW_WEBHOOK_URL missing");
  const res = await fetch(WORKFLOW_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Workflow POST failed: ${res.status} ${text}`);
  }
}

// ===== Bolt app =====
const app = new App({
  token: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET
});

// Slash command: /newitem → open modal
app.command("/newitem", async ({ ack, body, client }) => {
  await ack();
  const nextJob = nextJobFromCounter();
  const blocks = buildModalBlocks(nextJob);

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "phusa_newitem_modal",
      title: { type: "plain_text", text: "New Project" },
      submit: { type: "plain_text", text: "Create" },
      close: { type: "plain_text", text: "Cancel" },
      blocks
    }
  });
});

// Dependent dropdown: when Item changes, refresh Description
app.action("item", async ({ ack, body, client }) => {
  await ack();
  const chosenItem = body.actions?.[0]?.selected_option?.value;
  if (!chosenItem) return;
  const updatedBlocks = updateBlocksWithDescriptions(body.view.blocks, chosenItem);

  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: { ...body.view, blocks: updatedBlocks }
  });
});

// Submit → send to Workflow (adds row to Slack List)
app.view("phusa_newitem_modal", async ({ ack, body, view, client }) => {
  // Basic required validation
  const v = view.state.values;
  const required = ["client", "clientEmail", "quantity", "item", "description"];
  const errors = {};
  for (const bid of required) {
    const blk = v[bid];
    if (!blk) { errors[bid] = "Required"; continue; }
    const k = Object.keys(blk)[0];
    const val = blk[k]?.value || blk[k]?.selected_option?.value;
    if (!val) errors[bid] = "Required";
  }
  if (Object.keys(errors).length) {
    await ack({ response_action: "errors", errors });
    return;
  }
  await ack();

  const getText = (bid) => { const o=v[bid]; const k=Object.keys(o)[0]; return o[k]?.value || ""; };
  const getSel  = (bid) => { const o=v[bid]; const k=Object.keys(o)[0]; return o[k]?.selected_option?.value || ""; };

  const wf = {
    job_number:          getText("jobNumber"),
    client:              getText("client"),
    client_email:        getText("clientEmail"),
    date:                getText("date"),
    deadline:            getText("deadline"),
    status:              getSel("status"),
    quantity:            getText("quantity"),
    size:                getText("size"),
    invoice:             getText("invoice"),
    payment_status:      getSel("paymentStatus"),
    assignee:            "", // upgrade: use users_select and pass user id
    folder_link:         getText("folderLink"),
    item:                getSel("item"),
    description:         getSel("description"),
    notes:               getText("notes"),
    manufacture_notes:   getText("manufactureNotes"),
    manufacture:         getSel("manufacture"),
    second_manufacture:  getSel("secondManufacture"),
    delivery_address:    getText("deliveryAddress"),
    tracking:            getText("tracking"),
    design_time:         getText("designTime")
  };

  await postToWorkflow(wf);

  // Optional: quick confirmation to the user (ephemeral DM)
  try {
    await client.chat.postEphemeral({
      channel: body.user.id,
      user: body.user.id,
      text: `✅ ${wf.job_number || "(no #)"} added to “Test of PHUSA – PROJECTS – 2025 2”.`
    });
  } catch {}
});

// Start server
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ PHUSA /newitem running (Webhook→Slack List)");
})();

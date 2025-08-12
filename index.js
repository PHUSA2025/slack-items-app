import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bolt from '@slack/bolt';
const { App, ExpressReceiver } = bolt;
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------
//  Load catalog (JSON or CSV)
// -----------------------------
function loadCatalog() {
  const jsonPath = path.join(__dirname, 'catalog.json');
  const csvPath  = path.join(__dirname, 'catalog.csv');

  // Prefer JSON if present
  if (fs.existsSync(jsonPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    // Expect: { "A Frame": ["opt1","opt2","Custom"], ... }
    return data;
  }

  // Fallback to CSV if present
  if (fs.existsSync(csvPath)) {
    const csv = fs.readFileSync(csvPath, 'utf8');
    const rows = parse(csv, { columns: true, skip_empty_lines: true });
    // Expect CSV headers: Item,Description
    const map = {};
    for (const r of rows) {
      const item = (r.Item || '').trim();
      const desc = (r.Description || '').trim();
      if (!item || !desc) continue;
      if (!map[item]) map[item] = [];
      map[item].push(desc);
    }
    // ensure each item has "Custom" at the end (if vrei mereu disponibil)
    for (const k of Object.keys(map)) {
      if (!map[k].includes('Custom')) map[k].push('Custom');
    }
    return map;
  }

  // Default sample if nothing found
  return {
    "A Frame": [
      "White Deluxe A-Frame Signs + 2 inserts Durable - Reusable - Portable - Weather Resistant",
      "Black Metal Sidewalk A-Frame Signs + 2 inserts",
      "Custom"
    ],
    "Banners": [
      "13oz Vinyl Banner (hem + grommets)",
      "Mesh Banner (wind-permeable)",
      "Custom"
    ],
    "Stickers": [
      "Glossy Vinyl Stickers (die-cut)",
      "Matte Vinyl Stickers (kiss-cut sheet)",
      "Custom"
    ],
    "Business Cards": [
      "16pt + Matte Lamination (single-sided)",
      "16pt + Matte Lamination (double-sided)",
      "Custom"
    ],
    "Foamboard": [
      "3/16\" Foamboard, full color print",
      "3/16\" Foamboard, double-sided print",
      "Custom"
    ]
  };
}

const CATALOG = loadCatalog();

// Utility: Slack option labels max ~75 chars
const toOption = (txt) => ({
  text: { type: 'plain_text', text: txt.length > 75 ? txt.slice(0, 72) + '…' : txt },
  value: txt
});

// -----------------------------
//   Slack app setup (Express)
// -----------------------------
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// Health check (utile pt Render)
receiver.app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

// -----------------------------
//   Slash command: /newitem
// -----------------------------
app.command('/newitem', async ({ ack, body, client }) => {
  await ack();

  const itemOptions = Object.keys(CATALOG).map(toOption);

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'item_modal',
      title: { type: 'plain_text', text: 'New Item' },
      submit: { type: 'plain_text', text: 'Save' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'item_block',
          label: { type: 'plain_text', text: 'Item' },
          element: {
            type: 'static_select',
            action_id: 'item_select',
            placeholder: { type: 'plain_text', text: 'Choose an item' },
            options: itemOptions
          }
        },
        {
          type: 'section',
          block_id: 'desc_placeholder',
          text: { type: 'mrkdwn', text: '_Select an Item to load descriptions…_' }
        }
      ]
    }
  });
});

// Când selectezi Item → încarcă Description
app.action('item_select', async ({ ack, body, client }) => {
  await ack();

  const view = body.view;
  const selectedItem =
    body.actions?.[0]?.selected_option?.value || null;

  const descs = (selectedItem && CATALOG[selectedItem]) || [];
  const descOptions = descs.map(toOption);

  const newBlocks = [
    view.blocks.find(b => b.block_id === 'item_block'),
    {
      type: 'input',
      block_id: 'desc_block',
      label: { type: 'plain_text', text: 'Description' },
      element: {
        type: 'static_select',
        action_id: 'desc_select',
        placeholder: { type: 'plain_text', text: 'Choose a description' },
        options: descOptions
      }
    }
  ];

  await client.views.update({
    view_id: view.id,
    hash: view.hash,
    view: { ...view, blocks: newBlocks }
  });
});

// Când selectezi Description → dacă e Custom, arată input text
app.action('desc_select', async ({ ack, body, client }) => {
  await ack();

  const view = body.view;
  const selectedDesc = body.actions?.[0]?.selected_option?.value || '';

  const baseBlocks = [
    view.blocks.find(b => b.block_id === 'item_block'),
    view.blocks.find(b => b.block_id === 'desc_block')
  ];

  const blocks = selectedDesc === 'Custom'
    ? [
        ...baseBlocks,
        {
          type: 'input',
          block_id: 'custom_block',
          label: { type: 'plain_text', text: 'Custom Description' },
          element: {
            type: 'plain_text_input',
            action_id: 'custom_input',
            multiline: false,
            placeholder: { type: 'plain_text', text: 'Type your custom description…' }
          }
        }
      ]
    : baseBlocks;

  await client.views.update({
    view_id: view.id,
    hash: view.hash,
    view: { ...view, blocks }
  });
});

// Submit → trimite în canal (sau salvează în altă parte)
app.view('item_modal', async ({ ack, body, view, client }) => {
  await ack();

  const state = view.state.values;

  const item =
    state?.item_block?.item_select?.selected_option?.value || '—';

  const desc =
    state?.desc_block?.desc_select?.selected_option?.value || '—';

  const customText =
    state?.custom_block?.custom_input?.value || '';

  const finalDescription =
    desc === 'Custom' && customText ? customText : desc;

  await client.chat.postMessage({
    channel: process.env.SLACK_TARGET_CHANNEL || '#general',
    text: `*New Selection*\n• Item: ${item}\n• Description: ${finalDescription}`
  });
});

// Start
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ App running on port ${port}`);
})();

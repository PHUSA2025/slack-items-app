import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bolt from '@slack/bolt';
const { App, ExpressReceiver } = bolt;
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Catalogul pentru TEST:
 *  - A Frames (5 opțiuni)
 *  - Box (5 opțiuni)
 *  - Stickers (5 opțiuni)
 * Poți extinde ulterior aici sau în catalog.json / catalog.csv
 */
const TEST_CATALOG = {
  "A Frames": [
    "Double-sided frame 24x36",
    "Outdoor A-frame white",
    "Indoor A-frame black",
    "Foldable A-frame",
    "Heavy-duty A-frame",
    "Custom" // lăsăm mereu și Custom
  ],
  "Box": [
    "Small shipping box 10x10x5",
    "Medium retail box 12x12x8",
    "Large packaging box 20x20x15",
    "Custom printed box",
    "Kraft eco-friendly box",
    "Custom"
  ],
  "Stickers": [
    "Full color die-cut sticker",
    "Clear vinyl sticker",
    "Matte finish sticker",
    "Glossy round sticker",
    "Waterproof bumper sticker",
    "Custom"
  ]
};

// ===== Loader generic (opțional): catalog.json sau catalog.csv =====
function loadCatalog() {
  const jsonPath = path.join(__dirname, 'catalog.json');
  const csvPath  = path.join(__dirname, 'catalog.csv');

  if (fs.existsSync(jsonPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return data;
  }

  if (fs.existsSync(csvPath)) {
    const csv = fs.readFileSync(csvPath, 'utf8');
    const rows = parse(csv, { columns: true, skip_empty_lines: true });
    const map = {};
    for (const r of rows) {
      const item = (r.Item || '').trim();
      const desc = (r.Description || '').trim();
      if (!item || !desc) continue;
      if (!map[item]) map[item] = [];
      map[item].push(desc);
    }
    for (const k of Object.keys(map)) {
      if (!map[k].includes('Custom')) map[k].push('Custom');
    }
    return map;
  }

  // fallback: test catalog
  return TEST_CATALOG;
}

const CATALOG = loadCatalog();

// Slack option label limit (~75 chars)
const toOption = (txt) => ({
  text: { type: 'plain_text', text: txt.length > 75 ? txt.slice(0, 72) + '…' : txt },
  value: txt
});

// ------------- Slack app (ExpressReceiver) -------------
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver
});

// Health check (Render)
receiver.app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

// ------------- /newitem -------------
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
          label: { type: 'plain_text', text: 'New Items' },
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

// Item select → load Description options
app.action('item_select', async ({ ack, body, client }) => {
  await ack();

  const view = body.view;
  const selectedItem = body.actions?.[0]?.selected_option?.value || null;
  const descs = (selectedItem && CATALOG[selectedItem]) || [];
  const descOptions = descs.map(toOption);

  const newBlocks = [
    // păstrăm blocul cu Item
    view.blocks.find(b => b.block_id === 'item_block'),
    // Description dependent
    {
      type: 'input',
      block_id: 'desc_block',
      label: { type: 'plain_text', text: 'New Description' },
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

// Description select → if Custom, show text input
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

// Submit → post message (gata de copiat în List)
app.view('item_modal', async ({ ack, body, view, client }) => {
  await ack();

  const state = view.state.values;
  const item =
    state?.item_block?.item_select?.selected_option?.value || '—';
  const desc =
    state?.desc_block?.desc_select?.selected_option?.value || '—';
  const customText =
    state?.custom_block?.custom_input?.value || '';

  const finalDescription = (desc === 'Custom' && customText) ? customText : desc;

  const channel = process.env.SLACK_TARGET_CHANNEL || '#general';

  // mesaj compact, ușor de copiat în cele 2 coloane din List
  const text = `*New Items:* ${item}\n*New Description:* ${finalDescription}`;

  await client.chat.postMessage({
    channel,
    text
  });
});

// Start app
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ App running on port ${port}`);
})();

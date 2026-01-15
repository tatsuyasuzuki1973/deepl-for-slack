import { App, ExpressReceiver } from '@slack/bolt';
import { ConsoleLogger, LogLevel } from '@slack/logger';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const logLevel = process.env.SLACK_LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO;
const logger = new ConsoleLogger();
logger.setLevel(logLevel);

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: ['commands', 'chat:write', 'reactions:read'],
  logLevel,
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel,
});

// ---------------------------------------------------------------------------
// DeepL API Logic
// ---------------------------------------------------------------------------

interface DeepLTranslationResponse {
  translations: {
    detected_source_language: string;
    text: string;
  }[];
}

async function runDeepL(text: string, targetLang: string): Promise<string | null> {
  // FreeプランかProプランかでURLを切り替え
  const isFreePlan = process.env.DEEPL_FREE_API_PLAN === '1';
  const apiUrl = isFreePlan
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  try {
    // 2026/1/15以降の新認証方式: Authorization ヘッダー + JSON形式
    const result = await axios.post<DeepLTranslationResponse>(
      apiUrl,
      {
        text: [text],
        target_lang: targetLang,
      },
      {
        headers: {
          'Authorization': `DeepL-Auth-Key ${process.env.DEEPL_AUTH_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (
      result.data &&
      result.data.translations &&
      result.data.translations.length > 0
    ) {
      // 署名は削除しました（完成版）
      return result.data.translations[0].text;
    }
  } catch (e) {
    logger.error('Failed to call DeepL API', e);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slack App Logic
// ---------------------------------------------------------------------------

// 1. Emoji Reaction -> Translate
app.event('reaction_added', async ({ event, client, logger }) => {
  if (event.item.type === 'message') {
    // 翻訳先の言語コード判定
    let lang = '';
    const reactionName = event.reaction;
    if (reactionName.match(/QP/i)) { return; } // ignore custom emojis
    
    // 特殊な言語コードのマッピングを追加
    if (reactionName === 'flag-cn' || reactionName === 'cn') {
      lang = 'ZH'; // 中国語
    } else if (reactionName === 'flag-kr' || reactionName === 'kr') {
      lang = 'KO'; // 韓国語
    } else if (reactionName === 'flag-us' || reactionName === 'us' || reactionName === 'flag-gb' || reactionName === 'gb') {
      lang = 'EN-US';
    } else if (reactionName === 'flag-jp' || reactionName === 'jp') {
      lang = 'JA';
    } else if (reactionName.match(/flag-/)) {
      lang = reactionName.replace('flag-', '').toUpperCase();
    } else if (reactionName.match(/^[a-z]{2}$/)) {
      lang = reactionName.toUpperCase();
    }

    if (!lang) {
      // 言語フラグでないリアクションは無視
      return;
    }

    // リアクションされたメッセージを取得
    const replies = await client.conversations.replies({
      channel: event.item.channel,
      ts: event.item.ts,
      inclusive: true,
    });

    if (replies.messages && replies.messages.length > 0) {
      const message = replies.messages[0];
      if (message.text) {
        // DeepL API呼び出し
        const translatedText = await runDeepL(message.text, lang);
        if (translatedText) {
          // スレッドに翻訳結果を投稿
          await client.chat.postMessage({
            channel: event.item.channel,
            thread_ts: event.item.ts,
            text: translatedText,
          });
        }
      }
    }
  }
});

// 2. Shortcut -> Translate Modal
app.shortcut('deepl-translation', async ({ ack, body, client }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'deepl-modal',
      title: { type: 'plain_text', text: 'DeepL Translate' },
      submit: { type: 'plain_text', text: 'Translate' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'input',
          block_id: 'text-block',
          element: {
            type: 'plain_text_input',
            action_id: 'text',
            multiline: true,
            placeholder: { type: 'plain_text', text: 'Text to translate' },
          },
          label: { type: 'plain_text', text: 'Text' },
        },
        {
          type: 'input',
          block_id: 'lang-block',
          element: {
            type: 'plain_text_input',
            action_id: 'lang',
            placeholder: { type: 'plain_text', text: 'Language code (e.g. EN, JA)' },
            initial_value: 'EN',
          },
          label: { type: 'plain_text', text: 'Target Language' },
        },
      ],
    },
  });
});

app.view('deepl-modal', async ({ ack, view, client, body }) => {
  await ack();
  const text = view.state.values['text-block']['text'].value;
  const lang = view.state.values['lang-block']['lang'].value;
  if (text && lang) {
    const translatedText = await runDeepL(text, lang);
    if (translatedText) {
      // モーダルを開いたユーザーへDMで結果を通知
      await client.chat.postMessage({
        channel: body.user.id,
        text: `Translating "${text}" to ${lang}...\n\n> ${translatedText}`,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Start the App
// ---------------------------------------------------------------------------

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ DeepL for Slack app is running!');
})();

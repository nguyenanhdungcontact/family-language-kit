/* config.js — the ONE file a family edits to make this kit their own.
 *
 * Every page (TV dashboard, TV videos, iPad, phone, both games) loads this file first.
 * Change it on GitHub (pencil icon) or ask Claude Code / Antigravity: "update docs/config.js for my family".
 */
window.FAMILY_CONFIG = {
  /* Shown on the start page and the TV. */
  familyName: 'Our family',

  /* ---- Sync between TV, iPad and phones (optional) ----------------------------------------
   * A free Firebase Realtime Database keeps "watched" marks and saved ★ words the same on
   * every device. Leave syncDb as '' and each device simply keeps its own list.
   *
   * syncDb   : your database URL, e.g. 'https://my-family-default-rtdb.firebaseio.com'
   * syncCode : your family's private "room name": 20+ characters, only a-z 0-9 and dashes.
   *            Anyone who knows it can read/write your word list, so make it long and random.
   *            (Nothing personal is stored: only video ids and vocabulary.)
   *
   * The values below belong to the DEMO. Replace both before your family starts using the kit
   * (the setup guide, step 5, shows how).                                                    */
  syncDb: 'https://tv-video-daily-default-rtdb.asia-southeast1.firebasedatabase.app',
  syncCode: 'demo-family-kit-7q2m9x4k8w3v',

  /* ---- Languages ---------------------------------------------------------------------------
   * One entry per language being learned. The key (zh, vi) is also the folder name under
   * docs/data/ and video/. "who" is only a label on the profile cards.
   * tts = the voice used when a word is read aloud. badge = the letters on the TV profile card.
   * pronOnCards = show the pronunciation (pinyin) next to the meaning on meteors and game targets.  */
  defaultLang: 'zh',
  languages: {
    zh: { name: 'Chinese',    native: '中文',        who: 'Kids',  hello: '你好',     tts: 'zh-CN', badge: '中', pronOnCards: true },
    vi: { name: 'Vietnamese', native: 'Tiếng Việt', who: 'Dad',   hello: 'Xin chào', tts: 'vi-VN', badge: 'Vi', pronOnCards: false },
  },
};

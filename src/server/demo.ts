import { EventEmitter } from 'node:events';
import type { LiveEvent, LiveUser } from '../events.js';

const NAMES = ['pixelpanda', 'nightowl', 'lofi.luna', 'capt.crunch', 'mochi_mia', 'turbo.tim', 'starlight', 'bytebandit'];
const COMMENTS = ['hello!! 👋', 'this is so cool', 'W stream', 'first time here', 'lets gooo 🔥', 'how long have you been live?', 'GG', '😂😂😂'];
const GIFTS = [
  { giftId: 5655, giftName: 'Rose', diamondCount: 1, streakable: true },
  { giftId: 5269, giftName: 'TikTok', diamondCount: 1, streakable: true },
  { giftId: 5827, giftName: 'Ice Cream Cone', diamondCount: 1, streakable: true },
  { giftId: 6064, giftName: 'GG', diamondCount: 1, streakable: true },
  { giftId: 5487, giftName: 'Finger Heart', diamondCount: 5, streakable: true },
  { giftId: 6267, giftName: 'Corgi', diamondCount: 299, streakable: false },
  { giftId: 7934, giftName: 'Galaxy', diamondCount: 1000, streakable: false },
];

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

function fakeUser(): LiveUser {
  const name = pick(NAMES);
  return {
    userId: String(1000 + NAMES.indexOf(name)),
    uniqueId: name,
    nickname: name.replace(/[._]/g, ' '),
    profilePictureUrl: `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(name)}`,
  };
}

/**
 * Emits plausible fake events so overlays can be built and tested without
 * anyone being live. Selected with the username `demo`.
 */
export class DemoSource extends EventEmitter<{ event: [LiveEvent] }> {
  private timer: NodeJS.Timeout | undefined;
  private likes = 0;
  private viewers = 120;
  private seq = 0;

  start(): void {
    if (this.timer) return;
    const tick = () => {
      this.emitRandom();
      this.timer = setTimeout(tick, 400 + Math.random() * 1600);
    };
    tick();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private base() {
    return { timestamp: Date.now(), msgId: `demo-${++this.seq}` };
  }

  private emitRandom(): void {
    const roll = Math.random();
    if (roll < 0.35) {
      this.emit('event', { type: 'chat', ...this.base(), user: fakeUser(), comment: pick(COMMENTS), emotes: [] });
    } else if (roll < 0.55) {
      const likeCount = 1 + Math.floor(Math.random() * 15);
      this.likes += likeCount;
      this.emit('event', { type: 'like', ...this.base(), user: fakeUser(), likeCount, totalLikeCount: this.likes });
    } else if (roll < 0.68) {
      this.emit('event', { type: 'join', ...this.base(), user: fakeUser() });
    } else if (roll < 0.78) {
      this.viewers = Math.max(1, this.viewers + Math.floor(Math.random() * 21) - 8);
      this.emit('event', { type: 'viewers', ...this.base(), viewerCount: this.viewers, topViewers: [] });
    } else if (roll < 0.88) {
      this.emitGift();
    } else if (roll < 0.94) {
      this.emit('event', { type: 'follow', ...this.base(), user: fakeUser() });
    } else if (roll < 0.98) {
      this.emit('event', { type: 'share', ...this.base(), user: fakeUser() });
    } else {
      this.emit('event', { type: 'subscribe', ...this.base(), user: fakeUser(), subMonth: 1 + Math.floor(Math.random() * 6) });
    }
  }

  private emitGift(): void {
    const gift = pick(GIFTS);
    const user = fakeUser();
    const groupId = String(Date.now());
    const total = gift.streakable ? 1 + Math.floor(Math.random() * 8) : 1;
    const giftImageUrl = `https://api.dicebear.com/9.x/icons/svg?seed=${encodeURIComponent(gift.giftName)}`;
    for (let i = 1; i <= total; i++) {
      setTimeout(() => {
        const streaking = gift.streakable && i < total;
        this.emit('event', {
          type: 'gift',
          ...this.base(),
          user,
          giftId: gift.giftId,
          giftName: gift.giftName,
          giftImageUrl,
          diamondCount: gift.diamondCount,
          repeatCount: i,
          streaking,
          totalDiamonds: gift.diamondCount * i,
          groupId,
        });
      }, (i - 1) * 250);
    }
  }
}

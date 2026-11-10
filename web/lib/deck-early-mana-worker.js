import { earlyManaProbabilities } from './deck-early-mana.js';

self.onmessage = ({ data }) => {
  const { cards, options } = data;
  self.postMessage(earlyManaProbabilities(cards, options));
};

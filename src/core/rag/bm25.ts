// src/core/rag/bm25.ts - Keyword scoring for the hybrid search; identifiers split into words

/** Words of `text`: camelCase and snake_case split, lower-cased, one-character tokens dropped. */
export function tokenize(text: string): string[] {
  const spaced = text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
  return (spaced.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 1);
}

export class Bm25 {
  private readonly termFreqs: Map<string, number>[];
  private readonly lengths: number[];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(
    private readonly docs: readonly { id: string; text: string }[],
    private readonly k1 = 1.2,
    private readonly b = 0.75
  ) {
    this.termFreqs = docs.map((doc) => {
      const tf = new Map<string, number>();
      for (const t of tokenize(doc.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      return tf;
    });
    this.lengths = this.termFreqs.map((tf) => [...tf.values()].reduce((s, n) => s + n, 0));
    this.avgLength = this.lengths.reduce((s, n) => s + n, 0) / Math.max(1, docs.length);
  }

  /** Only documents sharing a term with the query appear in the map. */
  score(query: string): Map<string, number> {
    const scores = new Map<string, number>();
    const n = this.docs.length;
    for (const term of new Set(tokenize(query))) {
      const df = this.docFreq.get(term);
      if (!df) continue;
      // The +1 inside the log keeps idf positive for terms in more than half the documents.
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      this.termFreqs.forEach((tf, i) => {
        const f = tf.get(term);
        if (!f) return;
        const norm = f + this.k1 * (1 - this.b + (this.b * this.lengths[i]) / (this.avgLength || 1));
        const id = this.docs[i].id;
        scores.set(id, (scores.get(id) ?? 0) + (idf * f * (this.k1 + 1)) / norm);
      });
    }
    return scores;
  }
}

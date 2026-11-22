import { defineStore } from 'pinia'
import type { DraftSource } from '../services/record'

export const useDraftStore = defineStore('draft', {
  state: () => ({ text: '', source: 'text' as DraftSource }),
  actions: {
    edit(text: string) {
      this.text = text
      if (!text.trim()) this.source = 'text'
    },
    appendTranscript(text: string) {
      this.text = this.text.trim() ? this.text + '\n' + text : text
      this.source = 'voice'
    },
  },
})

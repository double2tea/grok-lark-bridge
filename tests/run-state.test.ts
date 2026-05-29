import { describe, expect, it } from 'vitest';
import { initialState, reduce, toCardBody } from '../src/card/run-state.js';

describe('run state card body', () => {
  it('merges streamed text chunks into one natural line', () => {
    const state = ['你', '好', '！'].reduce(
      (current, text) => reduce(current, { type: 'text', text }),
      initialState
    );

    expect(toCardBody(state)).toContain('你好！');
  });
});

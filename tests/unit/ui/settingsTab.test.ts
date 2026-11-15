import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { uiStub } from '../obsidian-mock';
import { DEFAULT_SETTINGS } from '../../../src/assets/constants';
import { PureChatLLMSettingTab } from '../../../src/ui/Settings';

/** A plugin with real default settings; anything else it is asked for is a stand-in. */
function fakePlugin(): any {
  const real: Record<string, unknown> = {
    settings: structuredClone(DEFAULT_SETTINGS),
    saveSettings: async () => {},
    modellist: [],
  };
  return new Proxy(real, {
    get(t, key: string) {
      if (key in t) return t[key];
      return uiStub();
    },
  });
}

test('the settings tab renders and returns', () => {
  const plugin = fakePlugin();
  const tab = new PureChatLLMSettingTab(uiStub(), plugin);
  const started = Date.now();
  tab.display();
  assert.ok(Date.now() - started < 2000, 'display() took more than 2 s');
});

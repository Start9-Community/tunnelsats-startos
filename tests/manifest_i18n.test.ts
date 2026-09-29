import test from 'node:test'
import assert from 'node:assert/strict'
import { short, long } from '../startos/manifest/i18n'

// "Gateway" wording in every locale the manifest ships.
const GATEWAY_WORDING = /gateway|puerta de enlace|passerelle|bramk|bram[ay]/i

test('manifest descriptions describe the storefront, not a VPN gateway', () => {
  for (const [name, texts] of Object.entries({ short, long })) {
    for (const [locale, text] of Object.entries(texts)) {
      assert.doesNotMatch(text, GATEWAY_WORDING, `${name}.${locale}`)
    }
  }
})

test('manifest descriptions name every supported node, including Eclair', () => {
  for (const [name, texts] of Object.entries({ short, long })) {
    for (const [locale, text] of Object.entries(texts)) {
      for (const node of ['LND', 'CLN', 'Eclair']) {
        assert.match(text, new RegExp(node), `${name}.${locale}: ${node}`)
      }
    }
  }
})

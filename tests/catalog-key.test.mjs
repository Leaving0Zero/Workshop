import test from 'node:test';import assert from 'node:assert/strict';import {transposeCatalogKey as shift} from '../src/catalog-key.mjs';
test('catalog keys retain spelling and mode at original pitch',()=>{for(const k of ['Bb minor','F#m','D Dorian','C major','Eb','C/G'])assert.equal(shift(k),k)});
test('catalog keys transpose by semitones, preserve mode and wrap octaves',()=>{assert.equal(shift('Bb minor',2),'C minor');assert.equal(shift('F#m',-2),'Em');assert.equal(shift('B major',1),'C major');assert.equal(shift('D Dorian',-12),'D Dorian');assert.equal(shift('C/G',2),'D/A');assert.equal(shift('E♭ minor',-1),'D minor')});
test('missing or unrecognized catalog keys are not invented',()=>{for(const k of ['',null,'Unknown','Custom','440 Hz'])assert.equal(shift(k,2),null)});

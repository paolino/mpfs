import { Store, Trie } from './mpf/lib';

const trie = await Trie.fromList([{ key: '42', value: '42' }]);

console.log(trie);
const proof = await trie.prove('42');

console.log(proof.toAiken());
console.log(trie.hash.toString('hex').toUpperCase());

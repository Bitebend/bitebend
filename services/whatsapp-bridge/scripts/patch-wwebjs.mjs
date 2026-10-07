import fs from 'node:fs';
import path from 'node:path';

// Patch Message.js in whatsapp-web.js to pass mimetype to downloadAndMaybeDecrypt
const searchPaths = [
  './node_modules/whatsapp-web.js/src/structures/Message.js',
  '../node_modules/whatsapp-web.js/src/structures/Message.js',
  '../../node_modules/whatsapp-web.js/src/structures/Message.js',
];

for (const relPath of searchPaths) {
  try {
    const fullPath = path.resolve(process.cwd(), relPath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('downloadAndMaybeDecrypt') && !content.includes('mimetype: msg.mimetype')) {
        const patched = content.replace(
          /type:\s*msg\.type,/,
          'type: msg.type,\n                        mimetype: msg.mimetype,',
        );
        fs.writeFileSync(fullPath, patched, 'utf8');
        console.log(`[patch-wwebjs] Successfully patched ${fullPath}`);
      }
    }
  } catch (err) {
    // Ignore optional search path errors
  }
}

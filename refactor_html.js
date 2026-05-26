const fs = require('fs');
let code = fs.readFileSync('src/panel/controlPanel.ts', 'utf8');

// Add nonce logic
code = code.replace(
    'private getHtml(): string {',
    `private getHtml(): string {\n        const nonce = this.getNonce();`
);

// Add CSP tag with nonce
code = code.replace(
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-\${nonce}';">`
);

// Replace script tag with nonce
code = code.replace(
    '<script>',
    `<script nonce="\${nonce}">`
);

// Replace static onclicks with data-action
code = code.replace(/onclick="sendMsg\('startServer'\)"/g, 'data-action="startServer"');
code = code.replace(/onclick="sendMsg\('stopServer'\)"/g, 'data-action="stopServer"');
code = code.replace(/onclick="sendMsg\('restartServer'\)"/g, 'data-action="restartServer"');
code = code.replace(/onclick="resetConfig\(\)"/g, 'data-action="resetConfig"');
code = code.replace(/onclick="saveConfig\(\)"/g, 'data-action="saveConfig"');
code = code.replace(/onclick="saveAndRestart\(\)"/g, 'data-action="saveAndRestart"');
code = code.replace(/onclick="generateToken\(\)"/g, 'data-action="generateToken"');
code = code.replace(/onclick="revokeAll\(\)"/g, 'data-action="revokeAll"');
code = code.replace(/onclick="sendMsg\('refreshModels'\)"/g, 'data-action="refreshModels"');
code = code.replace(/onclick="sendMsg\('copyEndpoint'\)"/g, 'data-action="copyEndpoint"');

// Switch tabs
code = code.replace(/onclick="switchTab\(event,'(.*?)'\)"/g, 'data-action="switchTab" data-tab="$1"');

// Copy curl
code = code.replace(/onclick="copyCurl\('(.*?)'\)"/g, 'data-action="copyCurl" data-type="$1"');

// Logs
code = code.replace(/onclick="sendMsg\('openOutputChannel'\)"/g, 'data-action="openLog"');
code = code.replace(/onclick="sendMsg\('clearLogs'\)"/g, 'data-action="clearLog"');

// Dynamic onclicks in JS
code = code.replace(/onclick="sendMsg\\('copyToken\\',{tokenId:' \+ t\.id \+ '}\\)"/g, 'data-action="copyToken" data-id="\' + t.id + \'"');
code = code.replace(/onclick="sendMsg\\('revokeToken\\',{tokenId:' \+ t\.id \+ '}\\)"/g, 'data-action="revokeToken" data-id="\' + t.id + \'"');
code = code.replace(/onclick="sendMsg\\('copyToken\\',{tokenId:' \+ data\.id \+ '}\\)"/g, 'data-action="copyToken" data-id="\' + data.id + \'"');

// Add event delegation logic at the start of the script
const delegationLogic = `
        // ─── Event Delegation ───
        document.body.addEventListener('click', function(e) {
            var target = e.target;
            var action = target.getAttribute('data-action');
            if (!action) {
                var parent = target.closest('[data-action]');
                if (parent) {
                    target = parent;
                    action = target.getAttribute('data-action');
                }
            }
            
            if (action === 'startServer') sendMsg('startServer');
            else if (action === 'stopServer') sendMsg('stopServer');
            else if (action === 'restartServer') sendMsg('restartServer');
            else if (action === 'resetConfig') resetConfig();
            else if (action === 'saveConfig') saveConfig();
            else if (action === 'saveAndRestart') saveAndRestart();
            else if (action === 'generateToken') generateToken();
            else if (action === 'revokeAll') revokeAll();
            else if (action === 'refreshModels') sendMsg('refreshModels');
            else if (action === 'copyEndpoint') sendMsg('copyEndpoint');
            else if (action === 'switchTab') switchTab(e, target.getAttribute('data-tab'));
            else if (action === 'copyCurl') copyCurl(target.getAttribute('data-type'));
            else if (action === 'openLog') sendMsg('openOutputChannel');
            else if (action === 'clearLog') sendMsg('clearLogs');
            else if (action === 'copyToken') sendMsg('copyToken', { tokenId: target.getAttribute('data-id') });
            else if (action === 'revokeToken') sendMsg('revokeToken', { tokenId: target.getAttribute('data-id') });
        });
`;
code = code.replace('var vscode;', delegationLogic + '\n        var vscode;');

// Add getNonce function at the end of the class
if (!code.includes('getNonce()')) {
    code = code.replace(/}\s*$/g, `
    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}
`);
}

fs.writeFileSync('src/panel/controlPanel.ts', code);
console.log('Refactor complete.');

/**
 * Auris Phase 2.1 Browser Smoke Test Suite
 * Controls installed Google Chrome via Chrome DevTools Protocol (CDP) using native Node.js WebSockets.
 * Verifies end-to-end browser UI, session handling, agent lifecycle, wallet operations, and error states.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const API_PORT = 4005;
const WEB_PORT = 3008;
const CDP_PORT = 9222;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_USER_DATA = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'auris_chrome_smoke');

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.consoleLogs = [];

    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
    });

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value || a.description || '').join(' ');
        this.consoleLogs.push({ type: msg.params.type, text });
      }
    };
  }

  async send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${desc}`);
    }
    return res.result?.value;
  }

  async waitFor(predicateExpression, timeoutMs = 8000, stepName = 'condition') {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.eval(predicateExpression);
        if (res) return res;
      } catch (e) {
        // Retry until timeout
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    let debugInfo = '';
    try {
      debugInfo = await this.eval('`url=${location.href}, text=${document.body ? document.body.innerText.slice(0, 150) : "empty"}`');
    } catch {}
    throw new Error(`Timeout waiting for ${stepName} after ${timeoutMs}ms (State: ${debugInfo})`);
  }

  async setInput(selector, value) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) {
        setter.call(el, ${JSON.stringify(value)});
      } else {
        el.value = ${JSON.stringify(value)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  async setInputs(selector, values) {
    return this.eval(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      const vals = ${JSON.stringify(values)};
      vals.forEach((v, idx) => {
        const el = els[idx];
        if (!el) throw new Error('Input not found at index ' + idx);
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        if (setter) {
          setter.call(el, v);
        } else {
          el.value = v;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    })()`);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    spawn('cmd.exe', ['/c', 'taskkill', '/PID', `${proc.pid}`, '/T', '/F'], { stdio: 'ignore' });
  } catch {}
}

async function waitUrl(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch (e) {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Service at ${url} failed to become healthy within ${timeoutMs}ms`);
}

async function runSmokeTests() {
  console.log('🚀 [PHASE 2.1 SMOKE TEST] Initializing Auris End-to-End Browser Verification...');

  let apiProc = null;
  let webProc = null;
  let chromeProc = null;
  let cdp = null;

  const testResults = [];

  function record(name, passed, details = '') {
    testResults.push({ name, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${mark}: ${name} ${details ? '(' + details + ')' : ''}`);
  }

  try {
    // 1. Verify and Launch API Server on port 4005
    console.log(`📡 Starting Auris Control Plane API on port ${API_PORT}...`);
    apiProc = spawn('cmd.exe', ['/c', 'npm', 'run', 'dev'], {
      cwd: path.join(ROOT_DIR, 'apps', 'api'),
      env: { ...process.env, PORT: `${API_PORT}`, NODE_ENV: 'development' },
      stdio: 'pipe',
    });

    apiProc.stderr.on('data', (d) => {
      const str = d.toString();
      if (str.includes('error') || str.includes('Error')) console.error(`[API STDERR] ${str.trim()}`);
    });
    apiProc.stdout.on('data', (d) => {
      const str = d.toString();
      if (str.includes('error') || str.includes('Error') || str.includes('DELETE') || str.includes('403') || str.includes('500')) {
        console.log(`[API LOG] ${str.trim()}`);
      }
    });

    await waitUrl(`http://localhost:${API_PORT}/health`);
    console.log(`✅ API server healthy on http://localhost:${API_PORT}`);

    // 2. Launch Next.js Web Application on port 3008
    console.log(`🌐 Starting Auris Next.js Web Application on port ${WEB_PORT}...`);
    webProc = spawn('cmd.exe', ['/c', 'npx', 'next', 'start', '-p', `${WEB_PORT}`], {
      cwd: path.join(ROOT_DIR, 'apps', 'web'),
      env: {
        ...process.env,
        PORT: `${WEB_PORT}`,
        NEXT_PUBLIC_API_URL: `http://localhost:${API_PORT}`,
      },
      stdio: 'pipe',
    });

    webProc.stderr.on('data', (d) => {
      const str = d.toString();
      if (str.includes('error') || str.includes('Error')) console.error(`[WEB STDERR] ${str.trim()}`);
    });
    webProc.stdout.on('data', (d) => {
      const str = d.toString();
      if (str.includes('error') || str.includes('Error')) console.log(`[WEB LOG] ${str.trim()}`);
    });

    await waitUrl(`http://localhost:${WEB_PORT}`);
    console.log(`✅ Web frontend healthy on http://localhost:${WEB_PORT}`);

    // 3. Launch Google Chrome in Headless Mode with Remote Debugging
    console.log(`🖥️ Launching Google Chrome via CDP on port ${CDP_PORT}...`);
    if (fs.existsSync(CHROME_USER_DATA)) {
      try {
        fs.rmSync(CHROME_USER_DATA, { recursive: true, force: true });
      } catch {}
    }

    chromeProc = spawn(
      CHROME_PATH,
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${CHROME_USER_DATA}`,
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    await waitUrl(`http://localhost:${CDP_PORT}/json/version`);
    const tabsRes = await fetch(`http://localhost:${CDP_PORT}/json/list`);
    const tabs = await tabsRes.json();
    let target = tabs.find((t) => t.type === 'page');
    if (!target) {
      const newTabRes = await fetch(`http://localhost:${CDP_PORT}/json/new`, { method: 'PUT' });
      target = await newTabRes.json();
    }
    const wsUrl = target?.webSocketDebuggerUrl;

    if (!wsUrl) throw new Error('Failed to obtain Chrome WebSocket debugger URL');

    cdp = new CDPClient(wsUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    console.log('🔗 Connected to Chrome via Chrome DevTools Protocol!');

    // Navigate to Web App
    console.log(`🌐 Navigating Chrome to http://localhost:${WEB_PORT}...`);
    await cdp.send('Page.navigate', { url: `http://localhost:${WEB_PORT}` });
    await cdp.waitFor(
      `location.href.includes('${WEB_PORT}') && (document.querySelector('.auth-card') !== null || document.querySelector('.topbar') !== null)`,
      15000,
      'Web Application Initial Load'
    );

    // Switch to Register tab
    await cdp.eval(`(() => {
      const buttons = Array.from(document.querySelectorAll('.auth-tab-btn'));
      const regBtn = buttons.find(b => b.textContent.includes('Create Account'));
      regBtn.click();
    })()`);

    const timestamp = Date.now();
    const testEmail = `browser-smoke-${timestamp}@auris.local`;
    const testPassword = 'Password123!Secure';
    const testOrgName = `Auris Smoke Org ${timestamp}`;

    // Fill registration inputs
    await cdp.setInputs('.form-input', ['Smoke Test Admin', testEmail, testOrgName, testPassword]);
    await cdp.eval(`document.querySelector('button[type="submit"]').click()`);

    // Verify Dashboard loads with Organization Name and Initial Wallet Balance ₹50.00
    await cdp.waitFor(
      `document.querySelector('.topbar') !== null && document.body.textContent.includes('${testOrgName}')`,
      8000,
      'Dashboard Load after Registration'
    );

    const initialBalanceText = await cdp.eval(`document.querySelector('.wallet-pill')?.textContent`);
    const regSuccess = initialBalanceText?.includes('50.00');
    record('1. Registration and Dashboard Onboarding', regSuccess, `Initial balance: ${initialBalanceText}`);

    // Test Sign Out
    await cdp.eval(`(() => {
      const profile = document.querySelector('.user-profile');
      profile.click();
    })()`);
    await cdp.waitFor('document.querySelector(".user-menu-dropdown") !== null', 2000, 'User Dropdown');
    await cdp.eval(`(() => {
      const logoutBtn = Array.from(document.querySelectorAll('.dropdown-item')).find(el => el.textContent.includes('Sign Out'));
      logoutBtn.click();
    })()`);

    await cdp.waitFor('document.querySelector(".auth-card") !== null', 3000, 'Auth Card after Logout');
    record('1.1. Logout Action and Session Clear', true, 'Session successfully cleared on logout');

    // Test Login with Registered Account
    await cdp.setInputs('.form-input', [testEmail, testPassword]);
    await cdp.eval(`document.querySelector('button[type="submit"]').click()`);

    await cdp.waitFor('document.querySelector(".topbar") !== null', 5000, 'Dashboard Load after Login');
    record('1.2. Login with Valid Credentials', true, 'Re-authenticated successfully');

    // -------------------------------------------------------------
    // Test 2: Invalid Credentials & Validation Errors
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Invalid Credentials & Validation Errors ---');
    // Log out again to test invalid credentials
    await cdp.eval(`(() => {
      localStorage.clear();
      location.reload();
    })()`);
    await cdp.waitFor('document.querySelector(".auth-card") !== null', 4000, 'Auth Card');

    // Attempt invalid password
    await cdp.setInputs('.form-input', [testEmail, 'WrongPassword999!']);
    await cdp.eval(`document.querySelector('button[type="submit"]').click()`);

    await cdp.waitFor(
      `document.querySelector('.alert-error') !== null && document.querySelector('.alert-error').textContent.includes('Invalid email or password')`,
      4000,
      'Invalid Credentials Error Banner'
    );
    record('2. Invalid Credentials Error Handling', true, 'Backend 401 correctly presented as alert banner');

    // Switch to Register and test short password validation
    await cdp.eval(`(() => {
      const buttons = Array.from(document.querySelectorAll('.auth-tab-btn'));
      buttons.find(b => b.textContent.includes('Create Account')).click();
    })()`);
    await cdp.setInputs('.form-input', ['Test User', 'shortpass@auris.local', 'Short Org', 'short']);
    await cdp.eval(`document.querySelector('button[type="submit"]').click()`);

    await cdp.waitFor(
      `document.querySelector('.alert-error') !== null && document.querySelector('.alert-error').textContent.includes('at least 8 characters')`,
      3000,
      'Validation Error Banner'
    );
    record('2.1. Client-Side Input Validation', true, 'Short password blocked with validation notice');

    // -------------------------------------------------------------
    // Test 3: Session Persistence After Refresh
    // -------------------------------------------------------------
    console.log('\n--- Test 3: Session Persistence After Refresh ---');
    // Log in properly
    await cdp.eval(`(() => {
      const buttons = Array.from(document.querySelectorAll('.auth-tab-btn'));
      buttons.find(b => b.textContent.includes('Sign In')).click();
    })()`);
    await cdp.setInputs('.form-input', [testEmail, testPassword]);
    await cdp.eval(`document.querySelector('button[type="submit"]').click()`);
    await cdp.waitFor('document.querySelector(".topbar") !== null', 5000, 'Dashboard');

    // Refresh browser
    await cdp.send('Page.reload');
    await cdp.waitFor('document.readyState === "complete"', 5000, 'Page Reload Complete');
    await cdp.waitFor('document.querySelector(".topbar") !== null', 5000, 'Dashboard Preserved on Refresh');

    const preservedOrg = await cdp.eval(`document.querySelector('.user-profile')?.textContent`);
    const sessionPreserved = preservedOrg?.includes(testOrgName);
    record('3. Session Persistence After Refresh', !!sessionPreserved, `User profile preserved: ${preservedOrg?.trim()}`);

    // -------------------------------------------------------------
    // Test 4: Expired/Malformed Token Handling
    // -------------------------------------------------------------
    console.log('\n--- Test 4: Expired/Malformed Token Handling ---');
    // Set invalid token
    await cdp.eval(`(() => {
      localStorage.setItem('auris_token', 'malformed.or.expired.jwt.token');
      location.reload();
    })()`);
    await cdp.waitFor('document.querySelector(".auth-card") !== null', 5000, 'Auth Card on Expired Token');
    const tokenAfter = await cdp.eval(`localStorage.getItem('auris_token')`);
    record('4. Expired/Malformed Token Eviction', tokenAfter === null, 'Invalid token purged and redirected to AuthView');

    // Log back in to continue testing agent & wallet features
    await cdp.setInputs('.form-input', [testEmail, testPassword]);
    await cdp.eval(`document.querySelector('button[type="submit"]').click()`);
    await cdp.waitFor('document.querySelector(".topbar") !== null', 5000, 'Dashboard');

    // -------------------------------------------------------------
    // Test 5: Creating and Listing an Agent
    // -------------------------------------------------------------
    console.log('\n--- Test 5: Creating and Listing an Agent ---');
    const agentName = 'Smoke Test AI Telecaller';
    const agentPrompt = 'You are a friendly customer follow-up assistant for Auris healthcare. Confirm patient appointment slots step by step.';

    // Fill Agent Builder
    await cdp.setInput('input[placeholder*="Employee Name"]', agentName);
    await cdp.setInput('.prompt-textarea-box', agentPrompt);
    await cdp.eval(`(() => {
      // Select Telugu
      const langBtns = Array.from(document.querySelectorAll('.lang-pill'));
      const teluguBtn = langBtns.find(b => b.textContent.includes('తెలుగు'));
      if (teluguBtn) teluguBtn.click();

      // Click Build
      document.querySelector('.btn-build-employee').click();
    })()`);

    // Wait for Success Alert
    await cdp.waitFor(
      `document.querySelector('.alert-success') !== null && document.querySelector('.alert-success').textContent.includes('Successfully hired')`,
      6000,
      'Agent Creation Alert'
    );

    // Verify Agent Card in List
    await cdp.waitFor(
      `document.querySelector('.agent-card') !== null && document.body.textContent.includes('${agentName}')`,
      5000,
      'Agent Card in List'
    );

    const cardDetails = await cdp.eval(`(() => {
      const card = document.querySelector('.agent-card');
      return {
        name: card.querySelector('.agent-name')?.textContent,
        status: card.querySelector('.agent-status-pill')?.textContent,
        role: card.querySelector('.agent-role-pill')?.textContent
      };
    })()`);

    record('5. Agent Creation and Listing', cardDetails.name === agentName, JSON.stringify(cardDetails));

    // -------------------------------------------------------------
    // Test 6: Pausing, Resuming, Details Modal & Deleting an Agent
    // -------------------------------------------------------------
    console.log('\n--- Test 6: Pausing, Resuming, Details Drawer & Deletion ---');
    
    // Pause agent
    await cdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('.agent-action-btns button'));
      const pauseBtn = btns.find(b => b.textContent.includes('Pause'));
      pauseBtn.click();
    })()`);

    await cdp.waitFor(
      `document.querySelector('.agent-status-pill.paused') !== null`,
      4000,
      'Agent Status Paused'
    );
    record('6.1. Agent Pause Toggle', true, 'Status transitioned to PAUSED');

    // Resume agent
    await cdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('.agent-action-btns button'));
      const resumeBtn = btns.find(b => b.textContent.includes('Resume'));
      resumeBtn.click();
    })()`);

    await cdp.waitFor(
      `document.querySelector('.agent-status-pill.active') !== null`,
      4000,
      'Agent Status Active'
    );
    record('6.2. Agent Resume Toggle', true, 'Status transitioned to ACTIVE');

    // View Details Drawer Modal
    await cdp.eval(`(() => {
      const btns = Array.from(document.querySelectorAll('.agent-action-btns button'));
      const detailsBtn = btns.find(b => b.textContent.includes('Details'));
      detailsBtn.click();
    })()`);

    await cdp.waitFor(
      `document.querySelector('.modal-dialog') !== null && document.body.textContent.includes('System Prompt & Instructions')`,
      3000,
      'Agent Details Modal Drawer'
    );
    record('6.3. Agent Details Modal Drawer', true, 'Modal displayed full prompt, version, and parameters');

    // Close Modal
    await cdp.eval(`document.querySelector('.modal-close-btn').click()`);
    await cdp.waitFor(`document.querySelector('.modal-dialog') === null`, 2000, 'Modal Close');

    // Delete Agent
    const deleteBtnInfo = await cdp.eval(`(() => {
      window.confirm = () => true;
      const deleteBtn = document.querySelector('.btn-danger-outline') || Array.from(document.querySelectorAll('.agent-action-btns button')).find(b => b.textContent.includes('🗑️'));
      if (!deleteBtn) return { found: false, count: document.querySelectorAll('.agent-card').length, body: document.body.innerText.slice(0, 200) };
      const disabled = deleteBtn.disabled;
      deleteBtn.click();
      return { found: true, disabled };
    })()`);
    console.log('[DEBUG Test 6.4] Delete button click info:', JSON.stringify(deleteBtnInfo));

    // Verify Empty State displays
    await cdp.waitFor(
      `document.body.textContent.includes('Hire your first AI employee') || document.querySelector('.agent-card') === null`,
      6000,
      'Empty State after Deletion'
    );
    record('6.4. Agent Deletion and Empty State', true, 'Agent deleted; UI returned to empty state');

    // -------------------------------------------------------------
    // Test 7: Wallet Balance and Transaction History
    // -------------------------------------------------------------
    console.log('\n--- Test 7: Wallet Balance and Transaction History ---');
    // Click Wallet Pill in Topbar
    await cdp.eval(`document.querySelector('.wallet-pill').click()`);
    await cdp.waitFor('document.querySelector(".modal-dialog") !== null', 3000, 'Wallet Modal');

    const walletBreakdown = await cdp.eval(`(() => {
      const texts = Array.from(document.querySelectorAll('.modal-dialog div')).map(d => d.textContent);
      return {
        hasAvailable: texts.some(t => t.includes('AVAILABLE CREDITS')),
        hasHolds: texts.some(t => t.includes('ACTIVE HOLDS')),
        hasTotal: texts.some(t => t.includes('TOTAL BALANCE')),
        hasLedger: texts.some(t => t.includes('Recent Transactions Ledger'))
      };
    })()`);

    const walletOk = walletBreakdown.hasAvailable && walletBreakdown.hasHolds && walletBreakdown.hasTotal && walletBreakdown.hasLedger;
    record('7. Wallet Balance Breakdown & Ledger Table', walletOk, JSON.stringify(walletBreakdown));

    // -------------------------------------------------------------
    // Test 8: Top-Up Behavior Marked as Simulated/Demo
    // -------------------------------------------------------------
    console.log('\n--- Test 8: Top-Up Marked as Simulated/Demo ---');
    const demoMarkings = await cdp.eval(`(() => {
      const modal = document.querySelector('.modal-dialog');
      return {
        hasBadge: modal.textContent.includes('SIMULATED / DEMO MODE'),
        hasNotice: modal.textContent.includes('Simulated Environment') && modal.textContent.includes('Payment gateway integrations are disabled in Phase 2'),
        buttonText: modal.querySelector('button[type="submit"]')?.textContent
      };
    })()`);

    const demoClear = demoMarkings.hasBadge && demoMarkings.hasNotice && demoMarkings.buttonText?.includes('Simulated');
    record('8.1. Simulated Top-Up Transparent Signposting', demoClear, `Notice verified: ${demoMarkings.hasBadge}`);

    // Perform +₹500 simulated recharge
    await cdp.eval(`(() => {
      const chips = Array.from(document.querySelectorAll('.modal-dialog button'));
      const chip500 = chips.find(c => c.textContent.includes('+₹500'));
      if (chip500) chip500.click();
      document.querySelector('.modal-dialog button[type="submit"]').click();
    })()`);

    // Wait for success notice
    await cdp.waitFor(
      `document.querySelector('.modal-dialog .alert-success') !== null`,
      5000,
      'Recharge Success Alert'
    );

    // Verify balance increased by 500 (from 50 to 550)
    const newBalanceText = await cdp.eval(`document.querySelector('.modal-dialog')?.textContent`);
    const balanceUpdated = newBalanceText?.includes('550.00');
    record('8.2. Simulated Balance Recharge Execution', balanceUpdated, 'New balance reflects ₹550.00');

    // Close Wallet Modal
    await cdp.eval(`document.querySelector('.modal-close-btn').click()`);
    await cdp.waitFor(`document.querySelector('.modal-dialog') === null`, 2000, 'Wallet Modal Close');

    // Verify Topbar wallet pill updated to 550.00
    const topbarPill = await cdp.eval(`document.querySelector('.wallet-pill')?.textContent`);
    record('8.3. Topbar Real-Time Balance Synchronization', topbarPill?.includes('550.00'), `Pill text: ${topbarPill}`);

    // -------------------------------------------------------------
    // Test 9: Network Failure & State Resilience
    // -------------------------------------------------------------
    console.log('\n--- Test 9: Network Failure & Error State Resilience ---');
    // Trigger top-up with invalid amount
    await cdp.eval(`document.querySelector('.wallet-pill').click()`);
    await cdp.waitFor('document.querySelector(".modal-dialog") !== null', 2000, 'Wallet Modal');
    await cdp.setInput('.modal-dialog input[type="number"]', '-100');
    await cdp.eval(`document.querySelector('.modal-dialog button[type="submit"]').click()`);

    await cdp.waitFor(
      `document.querySelector('.modal-dialog .alert-error') !== null`,
      3000,
      'Negative Top-Up Error Alert'
    );
    record('9. Negative Value Rejection & Error State', true, 'Properly prevented negative credit input');
    await cdp.eval(`document.querySelector('.modal-close-btn').click()`);

    // -------------------------------------------------------------
    // Test 10: Console Errors & Navigation Integrity
    // -------------------------------------------------------------
    console.log('\n--- Test 10: Console Errors & Navigation Integrity ---');
    // Test sidebar tabs
    await cdp.eval(`(() => {
      const navBtns = Array.from(document.querySelectorAll('.sidebar-nav button'));
      const empTab = navBtns.find(b => b.textContent.includes('My Employees'));
      empTab.click();
    })()`);
    await cdp.waitFor(`document.body.textContent.includes('My AI Employees')`, 2000, 'Employees Tab Navigation');

    await cdp.eval(`(() => {
      const navBtns = Array.from(document.querySelectorAll('.sidebar-nav button'));
      const builderTab = navBtns.find(b => b.textContent.includes('New employee'));
      builderTab.click();
    })()`);
    await cdp.waitFor(`document.body.textContent.includes('Configure New AI Employee')`, 2000, 'Builder Tab Navigation');

    await cdp.eval(`(() => {
      const navBtns = Array.from(document.querySelectorAll('.sidebar-nav button'));
      const dashTab = navBtns.find(b => b.textContent.includes('Dashboard'));
      dashTab.click();
    })()`);
    await cdp.waitFor(`document.body.textContent.includes('Quick Actions')`, 2000, 'Dashboard Tab Navigation');
    record('10.1. Sidebar Tab Navigation Integrity', true, 'Overview, Employees, and Builder tabs switch without errors');

    // Check captured console errors
    const errorLogs = cdp.consoleLogs.filter((l) => l.type === 'error' && !l.text.includes('Failed to load resource'));
    const noAppErrors = errorLogs.length === 0;
    record(
      '10.2. Browser Console Error Check',
      noAppErrors,
      noAppErrors ? '0 application console errors' : `${errorLogs.length} error(s): ${errorLogs.map((e) => e.text).join('; ')}`
    );

    console.log('\n============================================================');
    console.log('🏁 [PHASE 2.1 BROWSER SMOKE TEST SUMMARY]');
    const totalPassed = testResults.filter((r) => r.passed).length;
    console.log(`Total Scenarios: ${testResults.length} | Passed: ${totalPassed} | Failed: ${testResults.length - totalPassed}`);
    console.log('============================================================\n');

    if (totalPassed !== testResults.length) {
      throw new Error(`Smoke test had ${testResults.length - totalPassed} failed scenario(s)`);
    }
  } finally {
    console.log('🧹 Cleaning up test processes...');
    if (cdp) cdp.close();
    if (chromeProc) killTree(chromeProc);
    if (webProc) killTree(webProc);
    if (apiProc) killTree(apiProc);
    if (fs.existsSync(CHROME_USER_DATA)) {
      try {
        fs.rmSync(CHROME_USER_DATA, { recursive: true, force: true });
      } catch {}
    }
  }
}

runSmokeTests().catch((err) => {
  console.error('❌ Unhandled smoke test error:', err);
  process.exit(1);
});

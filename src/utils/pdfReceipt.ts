import { jsPDF } from 'jspdf';

export interface PdfTransactionItem {
  id: string;
  account_id: string;
  customer_id: string;
  agent_id: string | null;
  payee_id: string | null;
  payee_name: string;
  category: string;
  action: string;
  amount: number;
  amount_paise?: number;
  status: string;
  idempotency_key: string | null;
  note: string | null;
  created_at: number;
}

export interface PdfCustomerInfo {
  name: string;
  email: string;
  city: string;
}

export interface PdfAccountInfo {
  account_number: string;
  account_type: string;
  currency: string;
  balance: number;
  balance_paise?: number;
}

function sanitizePdfText(value: unknown): string {
  return String(value ?? '')
    .replace(/₹/g, 'Rs. ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');
}

function savePdfDoc(doc: jsPDF, filename: string): void {
  try {
    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch {
    doc.save(filename);
  }
}

function formatInr(amountRupees: number, amountPaise?: number): string {
  const val = typeof amountPaise === 'number' && Number.isFinite(amountPaise) ? amountPaise / 100 : Number(amountRupees || 0);
  return `INR ${val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateTime(ts: number): string {
  return new Date(Number(ts || Date.now())).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function downloadTransactionPdf(
  tx: PdfTransactionItem,
  customer: PdfCustomerInfo,
  account?: PdfAccountInfo
): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header band
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 88, 'F');

  doc.setTextColor(249, 115, 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('AGENTSHIELD · INDIBANK PROTECTED RECEIPT', 44, 34);

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(20);
  doc.text('Transaction Receipt', 44, 62);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(148, 163, 184);
  doc.text(`Generated ${formatDateTime(Date.now())}`, pageWidth - 44, 62, { align: 'right' });

  // Amount summary box
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(44, 112, pageWidth - 88, 76, 6, 6, 'FD');

  doc.setTextColor(100, 116, 139);
  doc.setFontSize(10);
  doc.text('SETTLED AMOUNT', 62, 136);

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text(formatInr(tx.amount), 62, 166);

  doc.setTextColor(5, 150, 105);
  doc.setFontSize(11);
  doc.text(sanitizePdfText(tx.status || 'completed').toUpperCase(), pageWidth - 62, 154, { align: 'right' });

  // Details table
  const rows: Array<[string, string]> = [
    ['Transaction ID', sanitizePdfText(tx.id)],
    ['Date & Time', formatDateTime(tx.created_at)],
    ['Payee', sanitizePdfText(tx.payee_name)],
    ['Category', sanitizePdfText(tx.category)],
    ['Action Type', sanitizePdfText(tx.action).replace('_', ' ').toUpperCase()],
    ['Account Holder', sanitizePdfText(`${customer.name} (${customer.email})`)],
    ['Account Number', sanitizePdfText(account ? `${account.account_number} · ${account.account_type}` : tx.account_id)],
    ['Initiating Agent', sanitizePdfText(tx.agent_id || 'Direct Customer')],
    ['Idempotency Key', sanitizePdfText(tx.idempotency_key || 'N/A')],
    ['Note', sanitizePdfText(tx.note || 'Authorized via AgentShield Gateway')],
  ];

  let y = 220;
  doc.setFontSize(10);
  for (const [label, value] of rows) {
    doc.setDrawColor(226, 232, 240);
    doc.line(44, y + 10, pageWidth - 44, y + 10);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(71, 85, 105);
    doc.text(label, 48, y);

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(15, 23, 42);
    const wrapped = doc.splitTextToSize(value, pageWidth - 240);
    doc.text(wrapped, 190, y);
    y += Math.max(28, wrapped.length * 14 + 14);
  }

  // Footer
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(
    'This receipt confirms the transaction passed AgentShield 5-stage zero-trust verification before bank settlement.',
    44,
    y + 26
  );

  savePdfDoc(doc, `agentshield-receipt-${tx.id}.pdf`);
}

export function downloadAllTransactionsPdf(
  transactions: PdfTransactionItem[],
  customer: PdfCustomerInfo,
  account?: PdfAccountInfo
): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 84, 'F');

  doc.setTextColor(249, 115, 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('AGENTSHIELD · INDIBANK STATEMENT', 40, 32);

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.text('Protected Transaction Statement', 40, 58);

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(sanitizePdfText(`Account Holder: ${customer.name} (${customer.city})`), 40, 108);
  if (account) {
    doc.text(sanitizePdfText(`Account: ${account.account_number} · Current Balance: ${formatInr(account.balance)}`), 40, 124);
  }
  doc.text(`Transactions Included: ${transactions.length}`, 40, 140);

  let y = 170;
  const drawHeader = () => {
    doc.setFillColor(241, 245, 249);
    doc.rect(40, y - 14, pageWidth - 80, 22, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(51, 65, 85);
    doc.text('Date', 46, y);
    doc.text('Payee / Category', 155, y);
    doc.text('Txn ID', 330, y);
    doc.text('Amount', pageWidth - 46, y, { align: 'right' });
    y += 22;
  };

  drawHeader();

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);

  for (const tx of transactions) {
    if (y > pageHeight - 60) {
      doc.addPage();
      y = 50;
      drawHeader();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
    }

    doc.setTextColor(71, 85, 105);
    doc.text(formatDateTime(tx.created_at), 46, y);

    doc.setTextColor(15, 23, 42);
    doc.text(sanitizePdfText(`${tx.payee_name} (${tx.category})`).slice(0, 32), 155, y);

    doc.setTextColor(100, 116, 139);
    doc.text(sanitizePdfText(tx.id), 330, y);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text(formatInr(tx.amount), pageWidth - 46, y, { align: 'right' });
    doc.setFont('helvetica', 'normal');

    doc.setDrawColor(226, 232, 240);
    doc.line(40, y + 8, pageWidth - 40, y + 8);
    y += 22;
  }

  savePdfDoc(doc, `agentshield-statement-${Date.now()}.pdf`);
}

export interface PdfAuditEntry {
  seq: number;
  id: string;
  timestamp: number;
  request_id: string;
  agent_id: string;
  agent_name: string;
  action: string;
  decision: string;
  risk_score: number;
  reasons: string[];
  entry_hash: string;
}

export interface PdfAuditVerifyResult {
  valid: boolean;
  totalEntries: number;
  verifiedEntries: number;
  brokenIndex: number | null;
  brokenEntryId: string | null;
  reason: string | null;
}

export function downloadAuditChainPdf(
  entries: PdfAuditEntry[],
  verifyResult: PdfAuditVerifyResult | null
): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageWidth, 84, 'F');

  doc.setTextColor(249, 115, 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('AGENTSHIELD · STAGE 5 CRYPTOGRAPHIC AUDIT LEDGER', 40, 32);

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.text('Tamper-Evident Audit Chain Report', 40, 58);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(148, 163, 184);
  doc.text(`Generated ${formatDateTime(Date.now())}`, pageWidth - 40, 58, { align: 'right' });

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(10);
  doc.text(`Total Exported Entries: ${entries.length}`, 40, 108);

  if (verifyResult) {
    const statusText = verifyResult.valid
      ? `Chain Verification: INTACT (${verifyResult.verifiedEntries}/${verifyResult.totalEntries} SHA-256 + HMAC links verified)`
      : `Chain Verification: BROKEN at index ${verifyResult.brokenIndex} (${verifyResult.brokenEntryId})`;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(verifyResult.valid ? 5 : 225, verifyResult.valid ? 150 : 29, verifyResult.valid ? 105 : 72);
    doc.text(sanitizePdfText(statusText), 40, 124);
  } else {
    doc.setTextColor(71, 85, 105);
    doc.text('Chain Verification: Not yet run in current session', 40, 124);
  }

  let y = 154;
  const drawHeader = () => {
    doc.setFillColor(241, 245, 249);
    doc.rect(40, y - 14, pageWidth - 80, 22, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(51, 65, 85);
    doc.text('Seq', 46, y);
    doc.text('Time', 80, y);
    doc.text('Agent / Action', 178, y);
    doc.text('Decision', 330, y);
    doc.text('Score', 402, y);
    doc.text('Entry Hash', 446, y);
    y += 20;
  };

  drawHeader();

  for (const entry of entries) {
    const primaryReason = sanitizePdfText(entry.reasons[0] || '');
    const reasonLines = primaryReason ? doc.splitTextToSize(primaryReason, pageWidth - 100) : [];
    const rowHeight = 20 + reasonLines.length * 11 + 8;

    if (y + rowHeight > pageHeight - 48) {
      doc.addPage();
      y = 48;
      drawHeader();
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text(`#${entry.seq}`, 46, y);

    doc.setFont('helvetica', 'normal');
    doc.text(formatDateTime(entry.timestamp), 80, y);

    doc.setTextColor(15, 23, 42);
    doc.text(sanitizePdfText(`${entry.agent_name || entry.agent_id} · ${entry.action}`).slice(0, 30), 178, y);

    if (entry.decision === 'ALLOW') {
      doc.setTextColor(5, 150, 105);
    } else if (entry.decision === 'ASK_CUSTOMER') {
      doc.setTextColor(217, 119, 6);
    } else {
      doc.setTextColor(225, 29, 72);
    }
    doc.setFont('helvetica', 'bold');
    doc.text(sanitizePdfText(entry.decision), 330, y);

    doc.setTextColor(15, 23, 42);
    doc.text(String(entry.risk_score), 408, y);

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(`${sanitizePdfText(entry.entry_hash).slice(0, 18)}...`, 446, y);

    if (reasonLines.length > 0) {
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(reasonLines, 80, y + 13);
    }

    doc.setDrawColor(226, 232, 240);
    doc.line(40, y + rowHeight - 8, pageWidth - 40, y + rowHeight - 8);
    y += rowHeight;
  }

  savePdfDoc(doc, `agentshield-audit-chain-${Date.now()}.pdf`);
}

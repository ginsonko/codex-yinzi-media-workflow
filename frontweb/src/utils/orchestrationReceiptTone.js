export function orchestrationReceiptTone(receipt) {
  if (receipt?.status === 'success') return 'receipt-success'
  if (receipt?.status === 'partial') return 'receipt-warning'
  if (receipt?.status === 'failed') return 'receipt-danger'
  return 'receipt-neutral'
}

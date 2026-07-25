/**
 * app/modules/validation.js
 *
 * Phase 4 (Operations Domain Implementation) frontend extraction, per
 * docs/adr/0004-incremental-frontend-modularization.md and the Phase 4
 * mission's "extract only the modules touched by: Inventory, Customer,
 * Sales, Repairs, Expenses, Configuration" scope.
 *
 * Extracted VERBATIM from app/ShopERP_Pro_v8.html — no logic changed, no
 * UI/styling/UX touched. Loaded via a plain <script src> tag (no build
 * step exists for this project) BEFORE the remaining inline <script>
 * blocks, exactly like modules/auth.js (Phase 2).
 *
 * What was extracted, and why exactly this piece: the field-validation
 * helpers (validatePhone/validateOptionalPhone/validateEmail/
 * validateRequired/validateNumeric/validateGST/validateIMEI) plus the
 * generic runner (runValidations) and inline-error display
 * (fieldErr/clearFieldErr) are the one genuinely self-contained,
 * DOM-only/pure-function layer shared identically across all 6 in-scope
 * areas — every add/edit form in Inventory, Customer, Sales, Repairs, and
 * Expenses calls into this same set (Configuration's own forms use the
 * same generic validators, though none needed a dedicated example in this
 * phase). Unlike auth.js's `_api` object, the Operations domain's actual
 * business logic (saveProduct, saveSale, saveJob, saveExpense, etc.) is
 * NOT extracted here, and deliberately so: every one of those functions is
 * entangled with the global `DB` blob, `saveDB()`, modal DOM IDs, and
 * page-specific mutable state (saleItems, editSaleOriginalItems, etc.) —
 * Phase 1.5's CanonicalDomainModel.md already established the Operations
 * domain exists ONLY as this entangled client-side blob today. Extracting
 * any one of those functions would require either dragging that whole
 * entanglement into a module (defeating the purpose of modularizing) or
 * restructuring it apart from the DOM/global state it depends on —
 * exactly the redesign this phase's mission explicitly forbids ("Do NOT
 * redesign UI... Only modularize"). This validation layer is the one
 * piece that was already written as a clean, reusable, DOM-and-argument-
 * only unit, making it the safe, zero-behavior-risk extraction — the same
 * judgment Phase 2 applied to `_api`.
 */

// ── Validation on save (returns error string or null) ──

function validatePhone(val, label){
  label=label||'Phone';
  const v=(val||'').replace(/\D/g,'');
  if(!v) return label+' is required';
  if(v.length!==10) return label+' must be exactly 10 digits';
  return null;
}
function validateOptionalPhone(val, label){
  if(!val||!val.trim()) return null; // optional - ok if empty
  return validatePhone(val, label);
}
function validateEmail(val){
  if(!val||!val.trim()) return null; // optional
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim())) return 'Invalid email address';
  return null;
}
function validateRequired(val, label){
  if(!val||!String(val).trim()) return (label||'This field')+' is required';
  return null;
}
function validateNumeric(val, label, min, max){
  const n=parseFloat(val);
  if(isNaN(n)) return (label||'Value')+' must be a number';
  if(min!==undefined&&n<min) return (label||'Value')+' must be at least '+min;
  if(max!==undefined&&n>max) return (label||'Value')+' must be at most '+max;
  return null;
}
function validateGST(val){
  if(!val||!val.trim()) return null; // optional
  if(!/^[A-Z0-9]{15}$/.test(val.trim().toUpperCase()))
    return 'GST number must be exactly 15 alphanumeric characters';
  return null;
}
function validateIMEI(val){
  if(!val||!val.trim()) return null; // optional
  if(!/^\d{15}$/.test(val.trim())) return 'IMEI must be exactly 15 digits';
  return null;
}

// ── Show inline field error ──
function fieldErr(id, msg){
  // Remove old error
  const old=document.getElementById('err-'+id);
  if(old)old.remove();
  if(!msg)return;
  const el=document.getElementById(id);
  if(!el)return;
  // Highlight field
  el.style.borderColor='var(--red)';
  el.style.boxShadow='0 0 0 2px rgba(239,68,68,.25)';
  // Show error message below
  const err=document.createElement('div');
  err.id='err-'+id;
  err.style.cssText='color:var(--red);font-size:10px;margin-top:3px;font-weight:600';
  err.textContent=msg;
  el.parentNode.insertBefore(err,el.nextSibling);
  // Auto-clear on input
  el.addEventListener('input',function clearErr(){
    el.style.borderColor='';el.style.boxShadow='';
    const e=document.getElementById('err-'+id);if(e)e.remove();
    el.removeEventListener('input',clearErr);
  },{once:true});
}
function clearFieldErr(id){
  const el=document.getElementById(id);
  if(el){el.style.borderColor='';el.style.boxShadow='';}
  const err=document.getElementById('err-'+id);
  if(err)err.remove();
}
// Run multiple validations - shows first error found, returns true if all pass
function runValidations(checks){
  let allPass=true;
  checks.forEach(([id,msg])=>{
    if(msg){fieldErr(id,msg);allPass=false;}
    else clearFieldErr(id);
  });
  if(!allPass){
    // Scroll to first error
    const first=document.querySelector('[id^="err-"]');
    if(first)first.scrollIntoView({behavior:'smooth',block:'center'});
  }
  return allPass;
}

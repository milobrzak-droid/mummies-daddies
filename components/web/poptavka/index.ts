/**
 * Komponenty poptávky, častých dotazů, právních stránek a 404.
 * InquiryWizard, ConfirmationText a CookieSettingsButton jsou klientské;
 * ostatní jsou bezstavové (server i klient). Texty dodávají stránky
 * z lib/web/poptavka/copy.ts (server-only).
 */
export { InquiryWizard, type WizardPrefill } from './InquiryWizard'
export { ConfirmationText } from './ConfirmationText'
export { CookieSettingsButton, COOKIE_SETTINGS_EVENT } from './CookieSettingsButton'
export { EstimateCard } from './EstimateCard'
export { JsonLd, faqPageJsonLd, productJsonLd } from './JsonLd'
export { LegalText, hasAnyPlaceholder } from './LegalText'
export { NotFoundView } from './NotFoundView'
export { Checkbox, ChoiceGroup, Field, FieldError, FieldHint, FIELD_CLASS, LABEL_CLASS, describedBy, type ChoiceOption } from './fields'
export { LegalPage } from './LegalPage'

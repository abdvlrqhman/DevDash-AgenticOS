/** "rtl" when text starts (its first letter) in a right-to-left script, Arabic or Hebrew and their kin; else "ltr". Pure, tested. */
export const textDir = (s: string): 'rtl' | 'ltr' =>
  /^[^\p{L}]*[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u.test(s) ? 'rtl' : 'ltr'

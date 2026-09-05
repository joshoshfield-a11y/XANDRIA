---
name: "♿ Accessibility Bug Report"
description: "Report accessibility issues or violations"
title: "[Accessibility] "
labels: ["accessibility", "bug", "triage"]
assignees: []
---

## ♿ Accessibility Issue Report

### **Issue Summary**
<!-- Provide a clear, concise description of the accessibility issue -->

### **WCAG Criteria Violated**
<!-- Which WCAG 2.1 guidelines are being violated? -->
- [ ] **1.1.1 Non-text Content** - Images, icons, charts lack text alternatives
- [ ] **1.3.1 Info and Relationships** - Information structure is not programmatically conveyed
- [ ] **1.3.2 Meaningful Sequence** - Reading order doesn't make sense
- [ ] **1.4.1 Use of Color** - Color alone conveys information
- [ ] **1.4.3 Contrast (Minimum)** - Text contrast ratio < 4.5:1
- [ ] **1.4.11 Non-text Contrast** - UI elements lack sufficient contrast
- [ ] **2.1.1 Keyboard** - Keyboard navigation not supported
- [ ] **2.1.2 No Keyboard Trap** - Users get stuck in focus loops
- [ ] **2.4.1 Bypass Blocks** - No skip links or heading navigation
- [ ] **2.4.2 Page Titled** - Page lacks descriptive title
- [ ] **2.4.6 Headings and Labels** - Headings/labels are not descriptive
- [ ] **3.1.1 Language of Page** - Page language not specified
- [ ] **4.1.1 Parsing** - HTML parsing errors
- [ ] **4.1.2 Name, Role, Value** - Interactive elements lack proper attributes

### **Severity Level**
<!-- How critical is this issue? -->
- [ ] **Critical** - Blocks access for users with disabilities
- [ ] **High** - Significantly impairs accessibility
- [ ] **Medium** - Moderate accessibility barrier
- [ ] **Low** - Minor accessibility improvement needed

### **User Impact**
<!-- Who is affected and how? -->
- [ ] **Screen reader users** - JAWS, NVDA, VoiceOver
- [ ] **Keyboard-only users** - Motor impairments, temporary injuries
- [ ] **Low vision users** - Screen magnification, contrast needs
- [ ] **Color blind users** - Color-dependent information
- [ ] **Cognitive disabilities** - Complex navigation, unclear content
- [ ] **Motor disabilities** - Precision clicking requirements

### **Environment**
- **Browser:** (e.g., Chrome 120, Firefox 119, Safari 17)
- **Operating System:** (e.g., Windows 11, macOS 14, Ubuntu 22.04)
- **Screen Reader:** (e.g., NVDA 2023.3, JAWS 2024, VoiceOver)
- **Assistive Technology:** (e.g., ZoomText, Dragon, keyboard navigation)
- **Device Type:** (Desktop, Mobile, Tablet)

### **Steps to Reproduce**
1. <!-- Step 1 -->
2. <!-- Step 2 -->
3. <!-- Step 3 -->

### **Expected Behavior**
<!-- What should happen instead? -->

### **Actual Behavior**
<!-- What currently happens? -->

### **Screenshots/Videos**
<!-- Add screenshots or videos demonstrating the issue -->
<!-- For contrast issues, include color picker readings -->

### **Code Location**
<!-- Where in the codebase is the problematic code? -->
- **File:** `path/to/file.tsx`
- **Component:** `ComponentName`
- **Line:** `42-58`

### **Suggested Fix**
<!-- If you have a suggestion for how to fix this -->

### **Testing Checklist**
<!-- How can this fix be verified? -->
- [ ] Screen reader announces content properly
- [ ] Keyboard navigation works
- [ ] Color contrast meets WCAG standards
- [ ] Focus indicators are visible
- [ ] Alternative text is descriptive
- [ ] Semantic HTML is used correctly

### **Additional Context**
<!-- Any other information that might be helpful -->

### **Related Issues/PRs**
<!-- Link to any related issues or pull requests -->

---

**Thank you for helping make XANDRIA accessible to everyone!** ♿✨
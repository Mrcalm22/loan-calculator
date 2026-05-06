"use strict";

const EPSILON = 1e-8;
const LOAN_TYPES = ["provident", "commercial"];

const DEFAULTS = {
  providentBalance: "500000",
  providentMonths: "194",
  providentMethod: "annuity",
  providentRateMode: "fixed",
  providentCurrentRate: "2.85",
  providentCurrentPayment: "",
  providentCurrentLpr: "",
  providentSpreadBps: "",
  providentMonthsToReset: "",
  providentFutureLpr: "",
  commercialBalance: "1326640.27",
  commercialMonths: "194",
  commercialMethod: "annuity",
  commercialRateMode: "lpr",
  commercialCurrentRate: "3.20",
  commercialCurrentPayment: "8767.96",
  commercialCurrentLpr: "3.50",
  commercialSpreadBps: "-30",
  commercialMonthsToReset: "1",
  commercialFutureLpr: "3.50",
  prepaymentTotal: "200000",
  allocationStrategy: "commercial-first",
  customProvident: "0",
  benchmarkReturn: "3.0",
  penaltyFee: "0",
};

const state = {
  selectedScenario: "baseline",
  calculations: null,
};

const LoanCalculatorCore = {
  parseNumber,
  clamp,
  formatCurrency,
  formatPercent,
  formatMonths,
  allocatePrepayment,
  calculateProjection,
};

function parseNumber(rawValue) {
  const normalized = String(rawValue ?? "")
    .replace(/,/g, "")
    .trim();

  if (normalized === "") {
    return NaN;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : NaN;
}

function toOptionalNumber(rawValue) {
  const normalized = String(rawValue ?? "")
    .replace(/,/g, "")
    .trim();

  if (normalized === "") {
    return null;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeRoundInt(value) {
  return Math.round(Number(value) || 0);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatCurrencyPrecise(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return "未计算";
  }

  return `${value.toFixed(digits)}%`;
}

function formatMonths(months) {
  if (!Number.isFinite(months) || months <= 0) {
    return "0个月";
  }

  const totalMonths = Math.round(months);
  const years = Math.floor(totalMonths / 12);
  const remain = totalMonths % 12;

  if (years > 0 && remain > 0) {
    return `${years}年${remain}个月`;
  }

  if (years > 0) {
    return `${years}年`;
  }

  return `${remain}个月`;
}

function payoffLabel(months) {
  if (!Number.isFinite(months) || months <= 0) {
    return "现在结清";
  }

  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + Math.round(months), 1);
  return `${target.getFullYear()}年${target.getMonth() + 1}月`;
}

function loanMonthlyRate(annualRate) {
  return annualRate / 100 / 12;
}

function benchmarkMonthlyRate(annualRate) {
  if (!Number.isFinite(annualRate) || annualRate <= 0) {
    return 0;
  }

  return Math.pow(1 + annualRate / 100, 1 / 12) - 1;
}

function annuityPayment(principal, annualRate, months) {
  if (principal <= EPSILON || months <= 0) {
    return 0;
  }

  const monthlyRate = loanMonthlyRate(annualRate);
  if (Math.abs(monthlyRate) <= EPSILON) {
    return principal / months;
  }

  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * monthlyRate * factor) / (factor - 1);
}

function solveAnnuityMonths(principal, annualRate, payment, maxMonths) {
  if (principal <= EPSILON) {
    return 0;
  }

  if (!Number.isFinite(payment) || payment <= EPSILON) {
    return maxMonths;
  }

  const monthlyRate = loanMonthlyRate(annualRate);

  if (Math.abs(monthlyRate) <= EPSILON) {
    return clamp(Math.ceil(principal / payment), 1, maxMonths);
  }

  if (payment <= principal * monthlyRate + EPSILON) {
    return maxMonths;
  }

  const months = Math.log(payment / (payment - principal * monthlyRate)) / Math.log(1 + monthlyRate);
  return clamp(Math.ceil(months - 1e-9), 1, maxMonths);
}

function zeroRow(month) {
  return {
    month,
    payment: 0,
    principal: 0,
    interest: 0,
    balance: 0,
    rate: 0,
  };
}

function emptySchedule() {
  return {
    rows: [],
    payment: 0,
    fixedPrincipal: 0,
  };
}

function summarizeSchedule(rows) {
  return rows.reduce(
    (summary, row) => {
      summary.totalPayment += row.payment;
      summary.totalPrincipal += row.principal;
      summary.totalInterest += row.interest;
      summary.months += 1;
      return summary;
    },
    {
      totalPayment: 0,
      totalPrincipal: 0,
      totalInterest: 0,
      months: 0,
      firstPayment: rows[0]?.payment ?? 0,
      lastPayment: rows[rows.length - 1]?.payment ?? 0,
    },
  );
}

function normalizeLoan(rawLoan) {
  const spreadBps = rawLoan.spreadBps ?? null;
  const currentRate =
    isFiniteNumber(rawLoan.currentRate)
      ? rawLoan.currentRate
      : isFiniteNumber(rawLoan.currentLpr) && isFiniteNumber(spreadBps)
        ? rawLoan.currentLpr + spreadBps / 100
        : NaN;
  const inferredCurrentLpr =
    isFiniteNumber(rawLoan.currentLpr)
      ? rawLoan.currentLpr
      : isFiniteNumber(currentRate) && isFiniteNumber(spreadBps)
        ? currentRate - spreadBps / 100
        : NaN;
  const futureLpr =
    rawLoan.rateMode === "lpr"
      ? isFiniteNumber(rawLoan.futureLpr)
        ? rawLoan.futureLpr
        : inferredCurrentLpr
      : null;
  const futureRate =
    rawLoan.rateMode === "lpr"
      ? isFiniteNumber(futureLpr) && isFiniteNumber(spreadBps)
        ? futureLpr + spreadBps / 100
        : currentRate
      : currentRate;
  const monthsToReset =
    rawLoan.rateMode === "lpr"
      ? clamp(safeRoundInt(rawLoan.monthsToReset ?? 0), 0, Math.max(safeRoundInt(rawLoan.months), 0))
      : 0;

  return {
    ...rawLoan,
    currentRate,
    currentLpr: inferredCurrentLpr,
    futureLpr,
    futureRate,
    spreadBps,
    monthsToReset,
    currentPayment:
      isFiniteNumber(rawLoan.currentPayment) && rawLoan.currentPayment > 0
        ? rawLoan.currentPayment
        : null,
  };
}

function getRateSegments(loan, totalMonths) {
  if (totalMonths <= 0) {
    return [];
  }

  if (loan.rateMode !== "lpr") {
    return [
      {
        months: totalMonths,
        rate: loan.currentRate,
        label: "执行利率",
      },
    ];
  }

  const currentMonths = clamp(loan.monthsToReset, 0, totalMonths);
  const futureMonths = totalMonths - currentMonths;
  const segments = [];

  if (currentMonths > 0) {
    segments.push({
      months: currentMonths,
      rate: loan.currentRate,
      label: "当前执行利率",
    });
  }

  if (futureMonths > 0) {
    segments.push({
      months: futureMonths,
      rate: loan.futureRate,
      label: "重定价后利率",
    });
  }

  return segments;
}

function buildAnnuitySchedule({ principal, months, loan, firstPaymentOverride = null }) {
  if (principal <= EPSILON || months <= 0) {
    return emptySchedule();
  }

  const rows = [];
  const segments = getRateSegments(loan, months);
  let balance = principal;
  let remainingMonths = months;
  let monthIndex = 0;
  let firstPayment = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length && balance > EPSILON && remainingMonths > 0; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const annualRate = segment.rate;
    const monthlyRate = loanMonthlyRate(annualRate);
    let payment =
      segmentIndex === 0 && isFiniteNumber(firstPaymentOverride) && firstPaymentOverride > EPSILON
        ? firstPaymentOverride
        : annuityPayment(balance, annualRate, remainingMonths);

    if (payment <= balance * monthlyRate + EPSILON) {
      payment = annuityPayment(balance, annualRate, remainingMonths);
    }

    const segmentMonths = Math.min(segment.months, remainingMonths);
    for (let localMonth = 0; localMonth < segmentMonths && balance > EPSILON && remainingMonths > 0; localMonth += 1) {
      const interest = balance * monthlyRate;
      let principalPay = payment - interest;
      let actualPayment = payment;

      if (principalPay <= EPSILON) {
        payment = annuityPayment(balance, annualRate, remainingMonths);
        principalPay = payment - interest;
        actualPayment = payment;
      }

      if (remainingMonths === 1 || principalPay >= balance - EPSILON) {
        principalPay = balance;
        actualPayment = principalPay + interest;
        balance = 0;
      } else {
        balance -= principalPay;
      }

      monthIndex += 1;
      remainingMonths -= 1;

      rows.push({
        month: monthIndex,
        payment: actualPayment,
        principal: principalPay,
        interest,
        balance,
        rate: annualRate,
      });

      if (monthIndex === 1) {
        firstPayment = actualPayment;
      }
    }
  }

  if (balance > EPSILON) {
    const annualRate = loan.rateMode === "lpr" ? loan.futureRate : loan.currentRate;
    const monthlyRate = loanMonthlyRate(annualRate);
    const interest = balance * monthlyRate;
    rows.push({
      month: monthIndex + 1,
      payment: balance + interest,
      principal: balance,
      interest,
      balance: 0,
      rate: annualRate,
    });
  }

  return {
    rows,
    payment: firstPayment || rows[0]?.payment || 0,
    fixedPrincipal: 0,
  };
}

function buildEqualPrincipalSchedule({ principal, fixedPrincipal, loan }) {
  if (principal <= EPSILON || fixedPrincipal <= EPSILON) {
    return emptySchedule();
  }

  const rows = [];
  let balance = principal;
  let month = 0;
  const maxMonths = 1200;

  while (balance > EPSILON && month < maxMonths) {
    const annualRate =
      loan.rateMode === "lpr" && month >= loan.monthsToReset ? loan.futureRate : loan.currentRate;
    const interest = balance * loanMonthlyRate(annualRate);
    const principalPay = Math.min(fixedPrincipal, balance);
    const payment = principalPay + interest;
    balance -= principalPay;
    month += 1;

    rows.push({
      month,
      payment,
      principal: principalPay,
      interest,
      balance,
      rate: annualRate,
    });
  }

  return {
    rows,
    payment: rows[0]?.payment ?? 0,
    fixedPrincipal,
  };
}

function buildLoanVariants(loan, prepayment) {
  if (loan.balance <= EPSILON || loan.months <= 0) {
    return {
      baseline: emptySchedule(),
      shorten: emptySchedule(),
      reduce: emptySchedule(),
    };
  }

  const appliedPrepayment = Math.min(prepayment, loan.balance);
  const reducedBalance = Math.max(loan.balance - appliedPrepayment, 0);

  if (loan.method === "equal-principal") {
    const baselineFixedPrincipal = loan.balance / loan.months;
    const baseline = buildEqualPrincipalSchedule({
      principal: loan.balance,
      fixedPrincipal: baselineFixedPrincipal,
      loan,
    });
    const reduce = buildEqualPrincipalSchedule({
      principal: reducedBalance,
      fixedPrincipal: reducedBalance > EPSILON ? reducedBalance / loan.months : 0,
      loan,
    });
    const shorten = buildEqualPrincipalSchedule({
      principal: reducedBalance,
      fixedPrincipal: baselineFixedPrincipal,
      loan,
    });

    return { baseline, shorten, reduce };
  }

  const baselinePayment =
    loan.currentPayment && loan.currentPayment > 0
      ? loan.currentPayment
      : annuityPayment(loan.balance, loan.currentRate, loan.months);
  const baseline = buildAnnuitySchedule({
    principal: loan.balance,
    months: loan.months,
    loan,
    firstPaymentOverride: baselinePayment,
  });
  const reduceFirstPayment =
    reducedBalance > EPSILON ? annuityPayment(reducedBalance, loan.currentRate, loan.months) : 0;
  const reduce = buildAnnuitySchedule({
    principal: reducedBalance,
    months: loan.months,
    loan,
    firstPaymentOverride: reduceFirstPayment,
  });
  const shortenPaymentTarget = baseline.rows[0]?.payment ?? baselinePayment;
  const shortenedMonths =
    reducedBalance > EPSILON
      ? solveAnnuityMonths(reducedBalance, loan.currentRate, shortenPaymentTarget, loan.months)
      : 0;
  const shorten = buildAnnuitySchedule({
    principal: reducedBalance,
    months: shortenedMonths,
    loan,
    firstPaymentOverride: shortenPaymentTarget,
  });

  return { baseline, shorten, reduce };
}

function combineSchedules(providentRows, commercialRows) {
  const maxLength = Math.max(providentRows.length, commercialRows.length);
  const combined = [];

  for (let index = 0; index < maxLength; index += 1) {
    const provident = providentRows[index] ?? zeroRow(index + 1);
    const commercial = commercialRows[index] ?? zeroRow(index + 1);

    combined.push({
      month: index + 1,
      payment: provident.payment + commercial.payment,
      principal: provident.principal + commercial.principal,
      interest: provident.interest + commercial.interest,
      providentBalance: provident.balance,
      commercialBalance: commercial.balance,
      totalBalance: provident.balance + commercial.balance,
    });
  }

  return combined;
}

function strategyLabel(strategy) {
  switch (strategy) {
    case "commercial-first":
      return "优先冲商贷";
    case "provident-first":
      return "优先冲公积金";
    case "proportional":
      return "按剩余本金占比分配";
    case "custom":
      return "自定义分配";
    case "higher-rate-first":
    default:
      return "优先冲高利率贷款";
  }
}

function allocatePrepayment(raw) {
  const totalBalance = raw.provident.balance + raw.commercial.balance;
  const total = clamp(raw.prepaymentTotal, 0, totalBalance);

  if (total <= EPSILON) {
    return {
      provident: 0,
      commercial: 0,
      total: 0,
      strategyLabel: strategyLabel(raw.allocationStrategy),
      adjusted: false,
    };
  }

  const providentBalance = raw.provident.balance;
  const commercialBalance = raw.commercial.balance;
  let provident = 0;
  let commercial = 0;

  switch (raw.allocationStrategy) {
    case "commercial-first":
      commercial = Math.min(total, commercialBalance);
      provident = Math.min(total - commercial, providentBalance);
      break;
    case "provident-first":
      provident = Math.min(total, providentBalance);
      commercial = Math.min(total - provident, commercialBalance);
      break;
    case "proportional": {
      const proportion = totalBalance <= EPSILON ? 0 : providentBalance / totalBalance;
      provident = Math.min(total * proportion, providentBalance);
      commercial = Math.min(total - provident, commercialBalance);

      if (provident + commercial < total - EPSILON) {
        const remaining = total - provident - commercial;
        if (provident < providentBalance) {
          provident += Math.min(remaining, providentBalance - provident);
        }
        if (provident + commercial < total - EPSILON && commercial < commercialBalance) {
          commercial += Math.min(total - provident - commercial, commercialBalance - commercial);
        }
      }
      break;
    }
    case "custom": {
      const requestedProvident = clamp(raw.customProvident, 0, total);
      provident = Math.min(requestedProvident, providentBalance);
      commercial = Math.min(total - provident, commercialBalance);

      if (provident + commercial < total - EPSILON && provident < providentBalance) {
        provident += Math.min(total - provident - commercial, providentBalance - provident);
      }
      break;
    }
    case "higher-rate-first":
    default: {
      const commercialHigher =
        raw.commercial.currentRate > raw.provident.currentRate ||
        (Math.abs(raw.commercial.currentRate - raw.provident.currentRate) <= EPSILON &&
          commercialBalance >= providentBalance);

      if (commercialHigher) {
        commercial = Math.min(total, commercialBalance);
        provident = Math.min(total - commercial, providentBalance);
      } else {
        provident = Math.min(total, providentBalance);
        commercial = Math.min(total - provident, commercialBalance);
      }
      break;
    }
  }

  const appliedTotal = provident + commercial;
  return {
    provident,
    commercial,
    total: appliedTotal,
    strategyLabel: strategyLabel(raw.allocationStrategy),
    adjusted: Math.abs(appliedTotal - raw.prepaymentTotal) > 0.01,
  };
}

function monthlyDiffs(baselineRows, candidateRows) {
  const horizon = baselineRows.length;
  const diffs = [];

  for (let index = 0; index < horizon; index += 1) {
    const baselinePayment = baselineRows[index]?.payment ?? 0;
    const candidatePayment = candidateRows[index]?.payment ?? 0;
    diffs.push(Math.max(baselinePayment - candidatePayment, 0));
  }

  return diffs;
}

function futureValueOfDiffs(diffs, monthlyRate) {
  const horizon = diffs.length;
  return diffs.reduce((sum, value, index) => {
    return sum + value * Math.pow(1 + monthlyRate, horizon - index - 1);
  }, 0);
}

function npv(rate, cashflows) {
  return cashflows.reduce((sum, cashflow, index) => {
    return sum + cashflow / Math.pow(1 + rate, index);
  }, 0);
}

function irrMonthly(cashflows) {
  if (!cashflows.length || cashflows.every((value) => Math.abs(value) <= EPSILON)) {
    return null;
  }

  const zeroValue = npv(0, cashflows);
  if (Math.abs(zeroValue) <= 1e-10) {
    return 0;
  }

  let low = 0;
  let high = 0.1;
  let lowValue = zeroValue;
  let highValue = npv(high, cashflows);

  if (zeroValue > 0) {
    while (Number.isFinite(highValue) && lowValue * highValue > 0 && high < 1024) {
      high *= 2;
      highValue = npv(high, cashflows);
    }

    if (!Number.isFinite(highValue) || lowValue * highValue > 0) {
      return null;
    }
  } else {
    low = -0.5;
    lowValue = npv(low, cashflows);
    high = 0;
    highValue = zeroValue;

    while (Number.isFinite(lowValue) && lowValue * highValue > 0 && low > -0.999999) {
      low = -1 + (1 + low) / 2;
      lowValue = npv(low, cashflows);
    }

    if (!Number.isFinite(lowValue) || lowValue * highValue > 0) {
      return null;
    }
  }

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const mid = (low + high) / 2;
    const midValue = npv(mid, cashflows);

    if (Math.abs(midValue) <= 1e-10) {
      return mid;
    }

    if (lowValue * midValue > 0) {
      low = mid;
      lowValue = midValue;
    } else {
      high = mid;
      highValue = midValue;
    }
  }

  return (low + high) / 2;
}

function analyzeOpportunity(totalPrepayment, penaltyFee, annualBenchmarkRate, baselineRows, candidateRows) {
  const monthlyRate = benchmarkMonthlyRate(annualBenchmarkRate);
  const diffs = monthlyDiffs(baselineRows, candidateRows);
  const horizon = baselineRows.length;
  const investmentWithoutPrepay = totalPrepayment * Math.pow(1 + monthlyRate, horizon);
  const savingsInvestment = futureValueOfDiffs(diffs, monthlyRate);
  const penaltyFutureCost = penaltyFee * Math.pow(1 + monthlyRate, horizon);
  const deltaFutureValue = savingsInvestment - penaltyFutureCost - investmentWithoutPrepay;
  const monthlyIrr = irrMonthly([-(totalPrepayment + penaltyFee), ...diffs]);
  const annualIrr = monthlyIrr === null ? null : (Math.pow(1 + monthlyIrr, 12) - 1) * 100;

  return {
    monthlyRate,
    diffs,
    horizon,
    investmentWithoutPrepay,
    savingsInvestment,
    penaltyFutureCost,
    deltaFutureValue,
    annualIrr,
  };
}

function buildOption(key, label, baselineCombined, candidateCombined, totalPrepayment, penaltyFee, benchmarkRate) {
  const baselineSummary = summarizeSchedule(baselineCombined);
  const summary = summarizeSchedule(candidateCombined);

  return {
    key,
    label,
    rows: candidateCombined,
    summary,
    interestSaved: baselineSummary.totalInterest - summary.totalInterest,
    monthsSaved: baselineSummary.months - summary.months,
    firstPaymentReduction: baselineSummary.firstPayment - summary.firstPayment,
    payoffDate: payoffLabel(summary.months),
    baselinePayoffDate: payoffLabel(baselineSummary.months),
    opportunity: analyzeOpportunity(
      totalPrepayment,
      penaltyFee,
      benchmarkRate,
      baselineCombined,
      candidateCombined,
    ),
  };
}

function buildLoanNarrative(calculations, optionKey) {
  const optionLabel = optionKey === "shorten" ? "缩短年限" : "减少月供";
  const targeted = [
    {
      label: "公积金",
      allocation: calculations.allocation.provident,
      baseline: calculations.segmentBaseline.provident,
      option: calculations.segmentOptions[optionKey].provident,
    },
    {
      label: "商贷",
      allocation: calculations.allocation.commercial,
      baseline: calculations.segmentBaseline.commercial,
      option: calculations.segmentOptions[optionKey].commercial,
    },
  ].filter((item) => item.allocation > EPSILON);

  if (!targeted.length) {
    return `本次没有分配到任何贷款，${optionLabel}方案暂时不生效。`;
  }

  const parts = targeted.map((item) => {
    if (optionKey === "shorten") {
      const monthsSaved = item.baseline.months - item.option.months;
      return monthsSaved > 0
        ? `${item.label}预计提前 ${formatMonths(monthsSaved)} 结清`
        : `${item.label}结清时间基本不变`;
    }

    const reduction = (item.baseline.firstPayment ?? 0) - (item.option.firstPayment ?? 0);
    return `${item.label}首月月供预计减少 ${formatCurrency(reduction)}`;
  });

  return `${optionLabel}下，${parts.join("；")}。`;
}

function summarizeTargetedMonthsSaved(calculations, optionKey) {
  const candidates = [
    {
      allocation: calculations.allocation.provident,
      baseline: calculations.segmentBaseline.provident,
      option: calculations.segmentOptions[optionKey].provident,
    },
    {
      allocation: calculations.allocation.commercial,
      baseline: calculations.segmentBaseline.commercial,
      option: calculations.segmentOptions[optionKey].commercial,
    },
  ];

  return candidates.reduce((maxValue, segment) => {
    if (segment.allocation <= EPSILON) {
      return maxValue;
    }

    return Math.max(maxValue, segment.baseline.months - segment.option.months);
  }, 0);
}

function loanAssumptionLabel(name, loan) {
  if (loan.balance <= EPSILON || loan.months <= 0) {
    return `${name}：未录入。`;
  }

  if (loan.rateMode !== "lpr") {
    return `${name}：执行利率 ${formatPercent(loan.currentRate)}${loan.currentPayment ? `，首月按账单月供 ${formatCurrency(loan.currentPayment)} 校准` : ""}。`;
  }

  const futureRate = loan.futureRate;
  const spreadText = `${loan.spreadBps >= 0 ? "+" : ""}${loan.spreadBps}bp`;
  return `${name}：当前执行利率 ${formatPercent(loan.currentRate)}，${loan.monthsToReset}个月后按 LPR ${formatPercent(loan.futureLpr)} ${spreadText} 走到 ${formatPercent(futureRate)}${loan.currentPayment ? `，当前月供按 ${formatCurrency(loan.currentPayment)} 校准` : ""}。`;
}

function calculateProjection(rawInputs) {
  const allocation = allocatePrepayment(rawInputs);
  const providentVariants = buildLoanVariants(rawInputs.provident, allocation.provident);
  const commercialVariants = buildLoanVariants(rawInputs.commercial, allocation.commercial);

  const baselineCombined = combineSchedules(
    providentVariants.baseline.rows,
    commercialVariants.baseline.rows,
  );
  const shortenCombined = combineSchedules(
    providentVariants.shorten.rows,
    commercialVariants.shorten.rows,
  );
  const reduceCombined = combineSchedules(
    providentVariants.reduce.rows,
    commercialVariants.reduce.rows,
  );

  const segmentBaseline = {
    provident: summarizeSchedule(providentVariants.baseline.rows),
    commercial: summarizeSchedule(commercialVariants.baseline.rows),
  };
  const segmentOptions = {
    shorten: {
      provident: summarizeSchedule(providentVariants.shorten.rows),
      commercial: summarizeSchedule(commercialVariants.shorten.rows),
    },
    reduce: {
      provident: summarizeSchedule(providentVariants.reduce.rows),
      commercial: summarizeSchedule(commercialVariants.reduce.rows),
    },
  };

  const baselineSummary = summarizeSchedule(baselineCombined);
  const shorten = buildOption(
    "shorten",
    "缩短年限",
    baselineCombined,
    shortenCombined,
    allocation.total,
    rawInputs.penaltyFee,
    rawInputs.benchmarkReturn,
  );
  const reduce = buildOption(
    "reduce",
    "减少月供",
    baselineCombined,
    reduceCombined,
    allocation.total,
    rawInputs.penaltyFee,
    rawInputs.benchmarkReturn,
  );

  const helperData = {
    allocation,
    segmentBaseline,
    segmentOptions,
  };
  shorten.loanNarrative = buildLoanNarrative(helperData, "shorten");
  shorten.targetedMonthsSaved = summarizeTargetedMonthsSaved(helperData, "shorten");
  reduce.loanNarrative = buildLoanNarrative(helperData, "reduce");

  const best = [shorten, reduce].reduce((currentBest, option) => {
    if (!currentBest) {
      return option;
    }

    return option.opportunity.deltaFutureValue > currentBest.opportunity.deltaFutureValue
      ? option
      : currentBest;
  }, null);

  return {
    inputs: rawInputs,
    allocation,
    baseline: {
      rows: baselineCombined,
      summary: baselineSummary,
      payoffDate: payoffLabel(baselineSummary.months),
    },
    segmentBaseline,
    segmentOptions,
    options: {
      shorten,
      reduce,
    },
    assumptionText: `${loanAssumptionLabel("公积金", rawInputs.provident)} ${loanAssumptionLabel("商贷", rawInputs.commercial)}`,
    bestKey: best?.key ?? "shorten",
  };
}

function getElements() {
  return {
    form: document.getElementById("calculator-form"),
    exampleButton: document.getElementById("example-button"),
    resetButton: document.getElementById("reset-button"),
    formMessage: document.getElementById("form-message"),
    verdictCard: document.getElementById("verdict-card"),
    assumptionBanner: document.getElementById("assumption-banner"),
    summaryGrid: document.getElementById("summary-grid"),
    shortenCard: document.getElementById("shorten-card"),
    reduceCard: document.getElementById("reduce-card"),
    scheduleBody: document.getElementById("schedule-body"),
    tableSubtitle: document.getElementById("table-subtitle"),
    tabButtons: Array.from(document.querySelectorAll("[data-scenario]")),
    customProvidentField: document.getElementById("custom-provident-field"),
    rateModeFields: {
      provident: document.getElementById("provident-lpr-fields"),
      commercial: document.getElementById("commercial-lpr-fields"),
    },
    inputs: {
      providentBalance: document.getElementById("provident-balance"),
      providentMonths: document.getElementById("provident-months"),
      providentMethod: document.getElementById("provident-method"),
      providentRateMode: document.getElementById("provident-rate-mode"),
      providentCurrentRate: document.getElementById("provident-current-rate"),
      providentCurrentPayment: document.getElementById("provident-current-payment"),
      providentCurrentLpr: document.getElementById("provident-current-lpr"),
      providentSpreadBps: document.getElementById("provident-spread-bps"),
      providentMonthsToReset: document.getElementById("provident-months-to-reset"),
      providentFutureLpr: document.getElementById("provident-future-lpr"),
      commercialBalance: document.getElementById("commercial-balance"),
      commercialMonths: document.getElementById("commercial-months"),
      commercialMethod: document.getElementById("commercial-method"),
      commercialRateMode: document.getElementById("commercial-rate-mode"),
      commercialCurrentRate: document.getElementById("commercial-current-rate"),
      commercialCurrentPayment: document.getElementById("commercial-current-payment"),
      commercialCurrentLpr: document.getElementById("commercial-current-lpr"),
      commercialSpreadBps: document.getElementById("commercial-spread-bps"),
      commercialMonthsToReset: document.getElementById("commercial-months-to-reset"),
      commercialFutureLpr: document.getElementById("commercial-future-lpr"),
      prepaymentTotal: document.getElementById("prepayment-total"),
      allocationStrategy: document.getElementById("allocation-strategy"),
      customProvident: document.getElementById("custom-provident"),
      benchmarkReturn: document.getElementById("benchmark-return"),
      penaltyFee: document.getElementById("penalty-fee"),
    },
    allocationProvident: document.getElementById("allocation-provident"),
    allocationCommercial: document.getElementById("allocation-commercial"),
    allocationTotal: document.getElementById("allocation-total"),
  };
}

function applyDefaults(elements, values = DEFAULTS) {
  Object.entries(values).forEach(([key, value]) => {
    if (elements.inputs[key]) {
      elements.inputs[key].value = value;
    }
  });
}

function syncConditionalFields(elements) {
  elements.customProvidentField.hidden = elements.inputs.allocationStrategy.value !== "custom";

  LOAN_TYPES.forEach((loanType) => {
    const isLprMode = elements.inputs[`${loanType}RateMode`].value === "lpr";
    elements.rateModeFields[loanType].hidden = !isLprMode;
  });
}

function collectInputs(elements) {
  const provident = normalizeLoan({
    balance: parseNumber(elements.inputs.providentBalance.value),
    months: parseNumber(elements.inputs.providentMonths.value),
    method: elements.inputs.providentMethod.value,
    rateMode: elements.inputs.providentRateMode.value,
    currentRate: toOptionalNumber(elements.inputs.providentCurrentRate.value),
    currentPayment: toOptionalNumber(elements.inputs.providentCurrentPayment.value),
    currentLpr: toOptionalNumber(elements.inputs.providentCurrentLpr.value),
    spreadBps: toOptionalNumber(elements.inputs.providentSpreadBps.value),
    monthsToReset: toOptionalNumber(elements.inputs.providentMonthsToReset.value),
    futureLpr: toOptionalNumber(elements.inputs.providentFutureLpr.value),
  });
  const commercial = normalizeLoan({
    balance: parseNumber(elements.inputs.commercialBalance.value),
    months: parseNumber(elements.inputs.commercialMonths.value),
    method: elements.inputs.commercialMethod.value,
    rateMode: elements.inputs.commercialRateMode.value,
    currentRate: toOptionalNumber(elements.inputs.commercialCurrentRate.value),
    currentPayment: toOptionalNumber(elements.inputs.commercialCurrentPayment.value),
    currentLpr: toOptionalNumber(elements.inputs.commercialCurrentLpr.value),
    spreadBps: toOptionalNumber(elements.inputs.commercialSpreadBps.value),
    monthsToReset: toOptionalNumber(elements.inputs.commercialMonthsToReset.value),
    futureLpr: toOptionalNumber(elements.inputs.commercialFutureLpr.value),
  });

  return {
    provident,
    commercial,
    prepaymentTotal: parseNumber(elements.inputs.prepaymentTotal.value),
    allocationStrategy: elements.inputs.allocationStrategy.value,
    customProvident: parseNumber(elements.inputs.customProvident.value || 0),
    benchmarkReturn: parseNumber(elements.inputs.benchmarkReturn.value),
    penaltyFee: parseNumber(elements.inputs.penaltyFee.value),
  };
}

function validateLoan(loan, label, errors) {
  if (!Number.isFinite(loan.balance) || loan.balance < 0) {
    errors.push(`${label}剩余本金需要是大于等于 0 的数字。`);
  }

  if (loan.balance > EPSILON && (!Number.isFinite(loan.months) || loan.months <= 0)) {
    errors.push(`${label}有余额时，剩余月数必须大于 0。`);
  }

  if (Number.isFinite(loan.months) && loan.months > 600) {
    errors.push(`${label}剩余月数看起来异常，请检查是否填成了年数。`);
  }

  if (loan.balance <= EPSILON) {
    return;
  }

  if (loan.rateMode === "lpr") {
    if (!Number.isFinite(loan.currentRate) && !(Number.isFinite(loan.currentLpr) && Number.isFinite(loan.spreadBps))) {
      errors.push(`${label}在 LPR 模式下，请填写当前执行利率，或填写 LPR 与加减基点。`);
    }

    if (!Number.isFinite(loan.spreadBps)) {
      errors.push(`${label}在 LPR 模式下，请填写加减基点。`);
    }

    if (!Number.isFinite(loan.monthsToReset) || loan.monthsToReset < 0) {
      errors.push(`${label}在 LPR 模式下，请填写距下次重定价剩余月数。`);
    }

    if (!Number.isFinite(loan.futureRate)) {
      errors.push(`${label}在 LPR 模式下，请填写可推导出未来执行利率的参数。`);
    }
  } else if (!Number.isFinite(loan.currentRate) || loan.currentRate < 0) {
    errors.push(`${label}当前执行年利率需要是大于等于 0 的数字。`);
  }

  if (loan.currentPayment !== null && (!Number.isFinite(loan.currentPayment) || loan.currentPayment < 0)) {
    errors.push(`${label}当前月供需要是大于等于 0 的数字。`);
  }
}

function validateInputs(raw) {
  const errors = [];
  validateLoan(raw.provident, "公积金贷款", errors);
  validateLoan(raw.commercial, "商业贷款", errors);

  if (raw.provident.balance + raw.commercial.balance <= EPSILON) {
    errors.push("至少需要录入一段仍未结清的贷款。");
  }

  if (!Number.isFinite(raw.prepaymentTotal) || raw.prepaymentTotal < 0) {
    errors.push("计划提前还款总额需要是大于等于 0 的数字。");
  }

  const totalBalance = raw.provident.balance + raw.commercial.balance;
  if (Number.isFinite(raw.prepaymentTotal) && raw.prepaymentTotal - totalBalance > EPSILON) {
    errors.push("计划提前还款总额不能超过当前剩余本金合计。");
  }

  if (!Number.isFinite(raw.benchmarkReturn) || raw.benchmarkReturn < 0) {
    errors.push("可替代年化收益率需要是大于等于 0 的数字。");
  }

  if (!Number.isFinite(raw.penaltyFee) || raw.penaltyFee < 0) {
    errors.push("违约金 / 手续费需要是大于等于 0 的数字。");
  }

  if (raw.allocationStrategy === "custom" && (!Number.isFinite(raw.customProvident) || raw.customProvident < 0)) {
    errors.push("自定义公积金冲还额需要是大于等于 0 的数字。");
  }

  return errors;
}

function renderValidationMessage(elements, message, type) {
  elements.formMessage.textContent = message;
  elements.formMessage.className = `form-message ${type === "error" ? "is-error" : "is-info"}`;
}

function renderAllocationPreview(elements, allocation) {
  elements.allocationProvident.textContent = formatCurrency(allocation.provident);
  elements.allocationCommercial.textContent = formatCurrency(allocation.commercial);
  elements.allocationTotal.textContent = formatCurrency(allocation.total);
}

function optionPlaceholder(label) {
  return `
    <div class="placeholder-block">
      <span class="placeholder-tag">${label}</span>
      <h3>等待测算</h3>
      <p>这里会显示节省利息、月供变化、结清时间变化和机会成本比较。</p>
    </div>
  `;
}

function renderEmptyState(elements) {
  elements.verdictCard.className = "verdict-card is-neutral";
  elements.verdictCard.innerHTML = `
    <div class="placeholder-block">
      <span class="placeholder-tag">等待输入</span>
      <h3>先录入贷款参数，再判断提前还款是否划算。</h3>
      <p>这里会给出结论、解释原因，并指出“缩短年限”和“减少月供”哪个更优。</p>
    </div>
  `;

  elements.assumptionBanner.textContent = "这里会展示本次测算采用的利率和月供假设。";
  elements.summaryGrid.innerHTML = `
    <article class="summary-card">
      <span>当前剩余本金</span>
      <strong>¥0</strong>
      <p>公积金与商贷合计</p>
    </article>
    <article class="summary-card">
      <span>原计划剩余总利息</span>
      <strong>¥0</strong>
      <p>按当前剩余期数估算</p>
    </article>
    <article class="summary-card">
      <span>当前首月月供</span>
      <strong>¥0</strong>
      <p>组合贷当月合计</p>
    </article>
    <article class="summary-card">
      <span>原计划结清时间</span>
      <strong>未计算</strong>
      <p>按浏览器当前日期推算</p>
    </article>
  `;
  elements.shortenCard.innerHTML = optionPlaceholder("缩短年限");
  elements.reduceCard.innerHTML = optionPlaceholder("减少月供");
  elements.scheduleBody.innerHTML = `
    <tr>
      <td colspan="7" class="empty-row">输入参数后，会在这里展开完整还款明细。</td>
    </tr>
  `;
  elements.tableSubtitle.textContent = "表格会展示你当前选中的方案。";
}

function renderVerdict(container, calculations) {
  const best = calculations.options[calculations.bestKey];
  const benchmark = calculations.inputs.benchmarkReturn;
  const betterThanInvest = best.opportunity.deltaFutureValue > 0;
  let className = "verdict-card";
  let tagClass = "verdict-tag";
  let tagText = "建议关注";
  let title = "先设置提前还款金额后再比较。";
  let description = "你还没有形成有效的提前还款方案。";

  if (calculations.allocation.total <= EPSILON) {
    className += " is-neutral";
    tagText = "未设置金额";
    title = "当前没有提前还款动作，无法判断值不值。";
    description = "录入计划提前还款总额后，系统会自动比较两种方案。";
  } else if (betterThanInvest) {
    tagText = "提前还款更优";
    title = `按 ${formatPercent(benchmark)} 的机会收益率假设，更建议选择“${best.label}”。`;
    description = `到原计划结清时点，提前还款并把后续节省下来的现金继续投入，预计会比“不提前还款、直接投资这笔钱”多出 ${formatCurrency(best.opportunity.deltaFutureValue)}。`;
  } else {
    className += " is-negative";
    tagClass = "verdict-tag option-tag-negative";
    tagText = "现金更灵活";
    title = `按 ${formatPercent(benchmark)} 的机会收益率假设，现在不急着提前还更有利。`;
    description = `在你的收益假设下，持有现金并投资的终值预计会比最佳提前还款方案高 ${formatCurrency(Math.abs(best.opportunity.deltaFutureValue))}。`;
  }

  container.className = className;
  container.innerHTML = `
    <span class="${tagClass}">${tagText}</span>
    <h3>${title}</h3>
    <p>${description}</p>
    <div class="verdict-metrics">
      <div class="verdict-metric">
        <span>最佳方案</span>
        <strong>${best.label}</strong>
      </div>
      <div class="verdict-metric">
        <span>隐含年化回报</span>
        <strong>${formatPercent(best.opportunity.annualIrr)}</strong>
      </div>
      <div class="verdict-metric">
        <span>预估节省利息</span>
        <strong>${formatCurrency(best.interestSaved)}</strong>
      </div>
    </div>
  `;
}

function renderSummary(container, calculations) {
  const totalBalance = calculations.inputs.provident.balance + calculations.inputs.commercial.balance;
  const baseline = calculations.baseline.summary;

  container.innerHTML = `
    <article class="summary-card">
      <span>当前剩余本金</span>
      <strong>${formatCurrency(totalBalance)}</strong>
      <p>公积金 ${formatCurrency(calculations.inputs.provident.balance)} + 商贷 ${formatCurrency(calculations.inputs.commercial.balance)}</p>
    </article>
    <article class="summary-card">
      <span>原计划剩余总利息</span>
      <strong>${formatCurrency(baseline.totalInterest)}</strong>
      <p>未来 ${formatMonths(baseline.months)} 内预计支付</p>
    </article>
    <article class="summary-card">
      <span>当前首月月供</span>
      <strong>${formatCurrency(baseline.firstPayment)}</strong>
      <p>最后一期约 ${formatCurrency(baseline.lastPayment)}</p>
    </article>
    <article class="summary-card">
      <span>原计划结清时间</span>
      <strong>${calculations.baseline.payoffDate}</strong>
      <p>还款期数约 ${formatMonths(baseline.months)}</p>
    </article>
  `;
}

function renderOptionCard(container, option, benchmarkRate) {
  const beatsBenchmark = option.opportunity.deltaFutureValue > 0;
  const typeClass = beatsBenchmark ? "option-tag option-tag-positive" : "option-tag option-tag-negative";
  const typeText = beatsBenchmark ? "值得考虑" : "收益不占优";
  const timeMetricLabel =
    option.key === "shorten"
      ? option.monthsSaved > 0
        ? "整体缩短期数"
        : "本段贷款缩短"
      : "首月少还";
  const timeMetricValue =
    option.key === "shorten"
      ? formatMonths(option.monthsSaved > 0 ? option.monthsSaved : option.targetedMonthsSaved || 0)
      : formatCurrency(option.firstPaymentReduction);
  const payoffNote =
    option.key === "shorten"
      ? `原计划 ${option.baselinePayoffDate}，预计可提前到 ${option.payoffDate} 结清。`
      : `保持剩余月数不变，预计仍在 ${option.payoffDate} 左右结清。`;

  container.innerHTML = `
    <div class="option-card-head">
      <div>
        <span class="${typeClass}">${typeText}</span>
        <h3>${option.label}</h3>
      </div>
      <div class="label-muted">和 ${formatPercent(benchmarkRate)} 的机会收益率比较</div>
    </div>
    <div class="option-metrics">
      <div class="option-metric">
        <span>新方案剩余总利息</span>
        <strong>${formatCurrency(option.summary.totalInterest)}</strong>
      </div>
      <div class="option-metric">
        <span>预估节省利息</span>
        <strong>${formatCurrency(option.interestSaved)}</strong>
      </div>
      <div class="option-metric">
        <span>${timeMetricLabel}</span>
        <strong>${timeMetricValue}</strong>
      </div>
      <div class="option-metric">
        <span>隐含年化回报</span>
        <strong>${formatPercent(option.opportunity.annualIrr)}</strong>
      </div>
      <div class="option-metric">
        <span>不提前还，直接投资这笔钱</span>
        <strong>${formatCurrency(option.opportunity.investmentWithoutPrepay)}</strong>
      </div>
      <div class="option-metric">
        <span>提前还后，把节省现金继续投资</span>
        <strong>${formatCurrency(option.opportunity.savingsInvestment - option.opportunity.penaltyFutureCost)}</strong>
      </div>
    </div>
    <p class="option-note">${payoffNote}</p>
    <p class="option-note">${option.loanNarrative}</p>
    <p class="option-note">
      到原计划结清时点，两种做法的终值差额约为
      <strong>${formatCurrency(option.opportunity.deltaFutureValue)}</strong>，
      ${beatsBenchmark ? "提前还款方案更占优。" : "继续持有现金更占优。"}
    </p>
  `;
}

function updateTabState(elements) {
  elements.tabButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.scenario === state.selectedScenario);
  });
}

function renderScheduleTable(elements) {
  if (!state.calculations) {
    elements.scheduleBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-row">输入参数后，会在这里展开完整还款明细。</td>
      </tr>
    `;
    elements.tableSubtitle.textContent = "表格会展示你当前选中的方案。";
    return;
  }

  const scenario = state.selectedScenario;
  let rows = state.calculations.baseline.rows;
  let subtitle = `原计划：还款 ${formatMonths(state.calculations.baseline.summary.months)}，剩余总利息 ${formatCurrency(state.calculations.baseline.summary.totalInterest)}。`;

  if (scenario === "shorten") {
    const option = state.calculations.options.shorten;
    rows = option.rows;
    const monthsText = option.monthsSaved > 0 ? formatMonths(option.monthsSaved) : formatMonths(option.targetedMonthsSaved || 0);
    subtitle = `缩短年限：预计节省利息 ${formatCurrency(option.interestSaved)}，目标贷款约提前 ${monthsText} 结清。`;
  } else if (scenario === "reduce") {
    const option = state.calculations.options.reduce;
    rows = option.rows;
    subtitle = `减少月供：首月少还 ${formatCurrency(option.firstPaymentReduction)}，剩余总利息减少 ${formatCurrency(option.interestSaved)}。`;
  }

  elements.tableSubtitle.textContent = subtitle;

  if (!rows.length) {
    elements.scheduleBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-row">该方案下贷款已结清。</td>
      </tr>
    `;
    return;
  }

  elements.scheduleBody.innerHTML = rows
    .map((row) => {
      return `
        <tr>
          <td>第 ${row.month} 期</td>
          <td>${formatCurrencyPrecise(row.payment)}</td>
          <td>${formatCurrencyPrecise(row.principal)}</td>
          <td>${formatCurrencyPrecise(row.interest)}</td>
          <td>${formatCurrencyPrecise(row.providentBalance)}</td>
          <td>${formatCurrencyPrecise(row.commercialBalance)}</td>
          <td>${formatCurrencyPrecise(row.totalBalance)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderResults(elements, calculations) {
  renderVerdict(elements.verdictCard, calculations);
  elements.assumptionBanner.textContent = calculations.assumptionText;
  renderSummary(elements.summaryGrid, calculations);
  renderOptionCard(elements.shortenCard, calculations.options.shorten, calculations.inputs.benchmarkReturn);
  renderOptionCard(elements.reduceCard, calculations.options.reduce, calculations.inputs.benchmarkReturn);

  if (!state.selectedScenario || state.selectedScenario === "baseline") {
    state.selectedScenario = calculations.bestKey;
  }

  updateTabState(elements);
  renderScheduleTable(elements);
}

function recalculate(elements) {
  const raw = collectInputs(elements);
  const errors = validateInputs(raw);

  if (errors.length > 0) {
    renderValidationMessage(elements, errors[0], "error");
    renderAllocationPreview(elements, {
      provident: 0,
      commercial: 0,
      total: 0,
    });
    state.calculations = null;
    renderEmptyState(elements);
    return;
  }

  const calculations = calculateProjection(raw);
  state.calculations = calculations;

  renderValidationMessage(
    elements,
    calculations.allocation.adjusted
      ? "分配金额已按贷款余额自动修正。"
      : `${calculations.allocation.strategyLabel}已应用；若填了当前月供，系统会优先按账单月供校准。`,
    "info",
  );
  renderAllocationPreview(elements, calculations.allocation);
  renderResults(elements, calculations);
}

function init() {
  const elements = getElements();
  if (!elements.form) {
    return;
  }

  applyDefaults(elements);
  syncConditionalFields(elements);

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    recalculate(elements);
  });

  elements.form.addEventListener("input", () => {
    recalculate(elements);
  });

  elements.form.addEventListener("change", () => {
    syncConditionalFields(elements);
    recalculate(elements);
  });

  elements.exampleButton.addEventListener("click", () => {
    applyDefaults(elements);
    syncConditionalFields(elements);
    recalculate(elements);
  });

  elements.resetButton.addEventListener("click", () => {
    applyDefaults(elements, {
      providentBalance: "",
      providentMonths: "",
      providentMethod: "annuity",
      providentRateMode: "fixed",
      providentCurrentRate: "",
      providentCurrentPayment: "",
      providentCurrentLpr: "",
      providentSpreadBps: "",
      providentMonthsToReset: "",
      providentFutureLpr: "",
      commercialBalance: "",
      commercialMonths: "",
      commercialMethod: "annuity",
      commercialRateMode: "fixed",
      commercialCurrentRate: "",
      commercialCurrentPayment: "",
      commercialCurrentLpr: "",
      commercialSpreadBps: "",
      commercialMonthsToReset: "",
      commercialFutureLpr: "",
      prepaymentTotal: "",
      allocationStrategy: "higher-rate-first",
      customProvident: "",
      benchmarkReturn: "3.0",
      penaltyFee: "0",
    });
    syncConditionalFields(elements);
    renderEmptyState(elements);
  });

  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedScenario = button.dataset.scenario;
      updateTabState(elements);
      renderScheduleTable(elements);
    });
  });

  recalculate(elements);
}

if (typeof window !== "undefined") {
  window.LoanCalculatorCore = LoanCalculatorCore;
  window.addEventListener("DOMContentLoaded", init);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = LoanCalculatorCore;
}

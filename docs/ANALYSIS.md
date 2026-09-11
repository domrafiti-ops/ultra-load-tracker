# Analysing the log

The point of two weeks of logging is not to admire the numbers. It is to answer
one question: **does this model describe your body, or only the literature's
average one?**

> **Getting the data into a spreadsheet:** press **Download CSV** in the app,
> then **File → Import** in Google Sheets and name the tab `sessions`. Every
> formula below references that tab by name and its columns by letter, so an
> imported CSV works as-is. Re-import over the same tab whenever you want to
> refresh.
>
> The app itself already shows the weekly rollup and both calibration
> correlations, so you only need a spreadsheet when you want to chart or slice
> beyond that.

Two coefficients in the model are assumptions rather than measurements —
`k_m` (the muscle damage exponent, default 1.5) and your descent step length
(default 1.05 m). Both are re-fittable from your own data. Nothing else needs
touching.

---

## The two calibration questions

### 1. Does Ê track your next-day quad soreness?

```
=CORREL(FILTER(sessions!O2:O,sessions!M2:M<>""),FILTER(sessions!M2:M,sessions!M2:M<>""))
```

**Strong positive (r ≥ 0.7):** the eccentric channel is tracking your actual
tissue response. Leave the defaults alone.

**Moderate (0.4–0.7):** usable. Try adjusting descent step length first — it is
the input you can actually measure, and Ê scales as its square root.

**Weak (< 0.4):** something is wrong, and it is *not* the descent metres — those
are measured. Work through, in order:

1. **Are you logging soreness consistently?** Same time each morning, same
   scale. Noise here masquerades as model failure.
2. **Descent step length.** Check a descent split on your watch: step length =
   descent distance ÷ (cadence × descent minutes). If yours is 0.85 m rather
   than 1.05, Ê is currently 11 % high.
3. **`k_m`.** Raise it if hard steep descents feel disproportionately worse than
   the model says; lower it if long gentle descents hurt more than predicted.
   Move in 0.25 steps and re-check the correlation.

### 2. Does AeL track your RPE?

```
=CORREL(FILTER(sessions!N2:N,sessions!L2:L<>""),FILTER(sessions!L2:L,sessions!L2:L<>""))
```

This should be strong for continuous sessions. If it is weak *specifically on
interval days*, that is expected and quantified: average heart rate under-counts
a session by roughly `1.843 × σ²_F`, about 7 % at σ_F = 0.20. Log intervals and
the rest of the run as two separate entries.

If it is weak across the board, check `HR max` and `HR rest` in your profile.
The whole aerobic channel is a fraction of that reserve span, and a wrong HR max
distorts everything non-linearly.

---

## Rolling load

The app shows these already. Put them on a second tab if you want them charted.

```
AeL, last 7 days   =SUMIFS(sessions!N:N,sessions!A:A,">="&TODAY()-6,sessions!A:A,"<="&TODAY())
Ê,   last 7 days   =SUMIFS(sessions!O:O,sessions!A:A,">="&TODAY()-6,sessions!A:A,"<="&TODAY())
AeL, days 8-14     =SUMIFS(sessions!N:N,sessions!A:A,">="&TODAY()-13,sessions!A:A,"<="&TODAY()-7)
Ê,   days 8-14     =SUMIFS(sessions!O:O,sessions!A:A,">="&TODAY()-13,sessions!A:A,"<="&TODAY()-7)
```

For a per-row trailing 7-day figure, put this in a spare column beside row 2 and
fill down:

```
=SUMIFS($N:$N,$A:$A,">="&$A2-6,$A:$A,"<="&$A2)
```

### Deliberately not included: acute:chronic workload ratio

You will find ACWR in every other training-load tool. It is left out here on
purpose. Wang's 2020 review documents the structural problems: it is a ratio of
two correlated quantities, the exponentially-weighted formulation has an
initial-load artefact, and it does not apply to sports that taper. Ultra
training is nothing but tapers and spikes.

Plot the two channels as rolling series and read the shape. Do not compute a
ratio and trust a threshold.

---

## The divergence question

```
=IFERROR(AVERAGE(FILTER(sessions!O2:O/sessions!N2:N,sessions!N2:N>0)),"")
```

This is the ratio the whole two-channel design exists to expose. Track it weekly
rather than per session.

- **Rising** — your training is becoming descent-dominant. Expect soreness and
  strength loss to lead the trend. Good if you are preparing for a
  descent-heavy race; a stress-injury risk if unintentional.
- **Falling** — you are accumulating aerobic work without the mechanical
  specificity. Fine in a base block, a problem six weeks out from a mountain
  race.
- **Flat and unchanging for weeks** — you are training one terrain profile.
  That is exactly the blind spot a single training-load number would hide from
  you.

---

## A chart worth making

Insert → Chart → Combo chart on the `sessions` tab:

- X axis: column A (`date`)
- Series 1: column N (`ael_au`), columns
- Series 2: column O (`ecc_au`), columns
- Series 3: column M (`soreness`), line on a **secondary axis**

If the soreness line rides the Ê bars rather than the AeL bars, the model is
doing its job — it is separating two things your body treats separately.

---

## Sample size honesty

Correlations on fewer than about 10 sessions are close to meaningless, and even
at 14 sessions a single hard descent day can dominate the fit. Two weeks tells
you whether the model is *directionally* right. Six weeks tells you whether the
coefficients are right. Do not re-fit `k_m` off five data points.

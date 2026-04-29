import Foundation
import HealthKit

/// Builds the same daily CSV schema as `sync_apple_health_desktop.py` from HealthKit samples.
final class HealthKitDailyAggregator {
    private let store = HKHealthStore()

    private final class DayBucket {
        var weights: [Double] = []
        var leans: [Double] = []
        var bodyFats: [Double] = []
        var steps: [Double] = []
        var proteins: [Double] = []
        var carbs: [Double] = []
        var fats: [Double] = []
        var kcals: [Double] = []
        var restingHrs: [Double] = []
        var training = false
    }

    private var buckets: [String: DayBucket] = [:]

    private func dayKey(for date: Date) -> String {
        let c = Calendar.current
        let y = c.component(.year, from: date)
        let m = c.component(.month, from: date)
        let d = c.component(.day, from: date)
        return String(format: "%04d-%02d-%02d", y, m, d)
    }

    private func bucket(for key: String) -> DayBucket {
        if let b = buckets[key] { return b }
        let n = DayBucket()
        buckets[key] = n
        return n
    }

    private var readTypes: Set<HKObjectType> {
        var s = Set<HKObjectType>()
        s.insert(HKObjectType.workoutType())
        let ids: [HKQuantityTypeIdentifier] = [
            .bodyMass, .leanBodyMass, .bodyFatPercentage, .stepCount,
            .dietaryProtein, .dietaryCarbohydrates, .dietaryFatTotal,
            .dietaryEnergyConsumed, .restingHeartRate,
        ]
        for id in ids {
            if let t = HKQuantityType.quantityType(forIdentifier: id) {
                s.insert(t)
            }
        }
        return s
    }

    func requestAuthorizationIfNeeded() async throws {
        guard HKHealthStore.isHealthDataAvailable() else {
            throw NSError(domain: "HealthDashboard", code: 1, userInfo: [NSLocalizedDescriptionKey: "Health data not available on this device"])
        }
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    private func avg(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    private func fetchQuantitySamples(
        type: HKQuantityType,
        unit: HKUnit,
        start: Date,
        end: Date,
        transform: (Double) -> Double = { $0 }
    ) async throws -> [(String, Double)] {
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        return try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: type, predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, err in
                if let err { cont.resume(throwing: err); return }
                guard let samples = samples as? [HKQuantitySample] else {
                    cont.resume(returning: [])
                    return
                }
                var out: [(String, Double)] = []
                out.reserveCapacity(samples.count)
                for s in samples {
                    let v = transform(s.quantity.doubleValue(for: unit))
                    out.append((self.dayKey(for: s.startDate), v))
                }
                cont.resume(returning: out)
            }
            self.store.execute(q)
        }
    }

    private func fetchWorkoutDays(start: Date, end: Date) async throws -> Set<String> {
        let pred = HKQuery.predicateForSamples(withStart: start, end: end, options: .strictStartDate)
        return try await withCheckedThrowingContinuation { cont in
            let q = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: pred, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, err in
                if let err { cont.resume(throwing: err); return }
                guard let samples = samples as? [HKWorkout] else {
                    cont.resume(returning: [])
                    return
                }
                var days = Set<String>()
                for w in samples {
                    days.insert(self.dayKey(for: w.startDate))
                }
                cont.resume(returning: days)
            }
            self.store.execute(q)
        }
    }

    private func normalizeBodyFat(_ raw: Double) -> Double {
        raw <= 1.0 ? raw * 100.0 : raw
    }

    private static func parseDateOnly(_ s: String) -> Date? {
        let df = DateFormatter()
        df.calendar = Calendar(identifier: .gregorian)
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone.current
        df.dateFormat = "yyyy-MM-dd"
        return df.date(from: s)
    }

    func buildDailyCsv() async throws -> String {
        let calendar = Calendar.current
        let end = Date()
        guard let start = calendar.date(byAdding: .day, value: -400, to: end) else {
            throw NSError(domain: "HealthDashboard", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid date range"])
        }

        let kg = HKUnit.gramUnit(with: .kilo)
        let g = HKUnit.gram()
        let kcal = HKUnit.kilocalorie()
        let pct = HKUnit.percent()
        let count = HKUnit.count()
        let bpm = HKUnit.count().unitDivided(by: HKUnit.minute())

        if let t = HKQuantityType.quantityType(forIdentifier: .bodyMass) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: kg, start: start, end: end) { bucket(for: d).weights.append(v) }
        }
        if let t = HKQuantityType.quantityType(forIdentifier: .leanBodyMass) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: kg, start: start, end: end) { bucket(for: d).leans.append(v) }
        }
        if let t = HKQuantityType.quantityType(forIdentifier: .bodyFatPercentage) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: pct, start: start, end: end, transform: normalizeBodyFat) {
                bucket(for: d).bodyFats.append(v)
            }
        }
        if let t = HKQuantityType.quantityType(forIdentifier: .stepCount) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: count, start: start, end: end) { bucket(for: d).steps.append(v) }
        }
        if let t = HKQuantityType.quantityType(forIdentifier: .dietaryProtein) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: g, start: start, end: end) { bucket(for: d).proteins.append(v) }
        }
        if let t = HKQuantityType.quantityType(forIdentifier: .dietaryCarbohydrates) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: g, start: start, end: end) { bucket(for: d).carbs.append(v) }
        }
        if let t = HKQuantityType.quantityType(forIdentifier: .dietaryFatTotal) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: g, start: start, end: end) { bucket(for: d).fats.append(v) }
        }
        if let t = HKQuantityType.quantityType(forIdentifier: .dietaryEnergyConsumed) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: kcal, start: start, end: end) { bucket(for: d).kcals.append(v) }
        }
        if let t = HKQuantityType.quantityType(forIdentifier: .restingHeartRate) {
            for (d, v) in try await fetchQuantitySamples(type: t, unit: bpm, start: start, end: end) { bucket(for: d).restingHrs.append(v) }
        }

        let trainingDays = try await fetchWorkoutDays(start: start, end: end)
        for d in trainingDays {
            bucket(for: d).training = true
        }

        let sortedKeys = buckets.keys.sorted()
        guard let lastKey = sortedKeys.last, let latestDate = Self.parseDateOnly(lastKey) else {
            return Self.csvHeaderOnly()
        }
        let latestStart = calendar.startOfDay(for: latestDate)
        guard let minKeep = calendar.date(byAdding: .day, value: -365, to: latestStart) else {
            return Self.csvHeaderOnly()
        }

        var lines = [Self.csvHeaderLine()]
        for day in sortedKeys {
            guard let dt = Self.parseDateOnly(day) else { continue }
            let d0 = calendar.startOfDay(for: dt)
            if d0 < calendar.startOfDay(for: minKeep) { continue }
            guard let b = buckets[day] else { continue }
            let w = avg(b.weights)
            let lean = avg(b.leans)
            let bf = avg(b.bodyFats)
            let st = b.steps.isEmpty ? "" : String(format: "%.0f", b.steps.reduce(0, +))
            let p = b.proteins.isEmpty ? "" : String(format: "%.2f", b.proteins.reduce(0, +))
            let k = b.kcals.isEmpty ? "" : String(format: "%.2f", b.kcals.reduce(0, +))
            let bfS = bf.map { String(format: "%.2f", $0) } ?? ""
            let leanS = lean.map { String(format: "%.4f", $0) } ?? ""
            let c = b.carbs.isEmpty ? "" : String(format: "%.2f", b.carbs.reduce(0, +))
            let f = b.fats.isEmpty ? "" : String(format: "%.2f", b.fats.reduce(0, +))
            let rh = avg(b.restingHrs).map { String(format: "%.1f", $0) } ?? ""
            let wS = w.map { String(format: "%.4f", $0) } ?? ""
            let tr = b.training ? "TRUE" : "FALSE"
            lines.append([day, wS, st, p, k, bfS, leanS, tr, c, f, rh].joined(separator: ","))
        }
        return lines.joined(separator: "\n")
    }

    private static func csvHeaderLine() -> String {
        "date,weightKg,steps,proteinG,kcal,bodyFatPct,leanMassKg,trainingDay,carbsG,fatG,restingHr"
    }

    private static func csvHeaderOnly() -> String {
        csvHeaderLine() + "\n"
    }
}

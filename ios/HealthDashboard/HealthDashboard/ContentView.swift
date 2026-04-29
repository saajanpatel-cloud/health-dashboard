import SwiftUI

struct ContentView: View {
    var body: some View {
        DashboardWebView()
            .ignoresSafeArea(edges: .bottom)
    }
}

#Preview {
    ContentView()
}

from pathlib import Path
import sys
import csv
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import joblib
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, classification_report, roc_auc_score

ROOT=Path(__file__).resolve().parents[1]
features=["Temperature","Vibration","RotationalSpeed","Pressure","MachineLoad"]
with (ROOT/"dataset"/"ai4i_sample.csv").open(newline="", encoding="utf-8") as csv_file:
    rows = list(csv.DictReader(csv_file))
X=np.asarray([[float(row[name]) for name in features] for row in rows], dtype=float)
y=np.asarray([int(row["Failure"]) for row in rows], dtype=int)
X_train,X_test,y_train,y_test=train_test_split(X,y,test_size=.2,random_state=42,stratify=y)
model=RandomForestClassifier(n_estimators=180,max_depth=12,min_samples_leaf=2,class_weight="balanced",random_state=42)
model.fit(X_train,y_train)
pred=model.predict(X_test)
print("Holdout accuracy:",round(accuracy_score(y_test,pred),3))
print(classification_report(y_test,pred,zero_division=0))
print("ROC AUC:",round(roc_auc_score(y_test,model.predict_proba(X_test)[:,1]),3))
joblib.dump(model,ROOT/"models"/"failure_model.joblib")
print("Saved trained model to models/failure_model.joblib")
